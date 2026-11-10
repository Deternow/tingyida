// 听译答 助手 · service worker
// 职责：侧边栏唤起 / 翻译请求代理 / 权限与 CSP 规则集管理

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

chrome.runtime.onStartup?.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
  restoreCspBypass();
});

// 兜底：behavior 未生效时手动打开
chrome.action.onClicked.addListener((tab) => {
  if (chrome.sidePanel?.open && tab?.id) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  }
});

// ---------------------------------------------------------------- CSP 规则集

// 规则集由浏览器托管，即便 service worker 被回收也不会失效。
// 但「是否启用」的状态存在 storage 里，worker 每次醒来都要重新套用一次。
async function restoreCspBypass() {
  try {
    const { cspBypass } = await chrome.storage.local.get('cspBypass');
    await applyCspBypass(!!cspBypass);
  } catch {
    /* 忽略 */
  }
}

async function applyCspBypass(on) {
  if (!chrome.declarativeNetRequest?.updateEnabledRulesets) return false;
  await chrome.declarativeNetRequest.updateEnabledRulesets(
    on ? { enableRulesetIds: ['csp_bypass'] } : { disableRulesetIds: ['csp_bypass'] }
  );
  return true;
}

restoreCspBypass();

// ---------------------------------------------------------------- 权限

const ALL_SITES = ['<all_urls>', 'file://*/*'];

async function permState() {
  const origins = ALL_SITES;
  let granted = false;
  try {
    granted = await chrome.permissions.contains({ origins });
  } catch {
    granted = false;
  }
  let dnrOn = false;
  try {
    const { cspBypass } = await chrome.storage.local.get('cspBypass');
    dnrOn = !!cspBypass;
  } catch {
    /* 忽略 */
  }
  return { granted, cspBypass: dnrOn };
}

// ---------------------------------------------------------------- 消息路由

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'background') return;

  // 网页翻译的请求代理：content script 直接 fetch 127.0.0.1 会被页面侧的
  // CSP / 私有网络策略挡下，由 service worker 代发就绕开了这些限制
  if (msg.type === 'translate-batch') {
    const base = String(msg.apiBase || 'http://127.0.0.1:8765').replace(/\/+$/, '');
    fetch(`${base}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: msg.texts || [] })
    })
      .then((r) => r.json())
      .then((d) => sendResponse(d))
      .catch((e) => sendResponse({ error: `连不上本地服务：${e.message}（先跑启动本地服务.bat）` }));
    return true;
  }

  if (msg.type === 'perm-state') {
    permState().then(sendResponse);
    return true;
  }

  if (msg.type === 'perm-request') {
    chrome.permissions
      .request({ origins: ALL_SITES })
      .then((ok) => permState().then((s) => sendResponse({ ...s, grantedNow: ok })))
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'csp-set') {
    const on = !!msg.on;
    chrome.storage.local
      .set({ cspBypass: on })
      .then(() => applyCspBypass(on))
      .then(() => permState())
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  // 枚举当前标签页的所有框架，用于诊断「哪些 iframe 没权限注入」
  if (msg.type === 'frames') {
    chrome.webNavigation
      .getAllFrames({ tabId: msg.tabId })
      .then((frames) => sendResponse({ frames: frames || [] }))
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  // 逐框架定向收发：tabs.sendMessage 广播只回第一个响应，必须带 frameId 逐个发。
  // content.js 由 manifest 常驻注入（不需要 activeTab），所以这条路不依赖任何权限。
  if (msg.type === 'translate-frames' || msg.type === 'clear-frames') {
    const payload =
      msg.type === 'translate-frames'
        ? { type: 'tyd-translate', apiBase: msg.apiBase }
        : { type: 'tyd-clear' };
    chrome.webNavigation
      .getAllFrames({ tabId: msg.tabId })
      .then((frames) =>
        Promise.all(
          // 浏览器内部框架（含我们自己的抽屉 iframe）不该计入，否则会被误判成「未注入」
          (frames || [])
            .filter((f) => !/^(chrome|chrome-extension|chrome-error|edge|devtools|view-source|data):/i.test(f.url || ''))
            .map(async (f) => {
            try {
              const result = await chrome.tabs.sendMessage(
                msg.tabId,
                payload,
                { frameId: f.frameId }
              );
              return { frameId: f.frameId, url: f.url, result };
            } catch (e) {
              return { frameId: f.frameId, url: f.url, error: String(e.message || e) };
            }
          })
        )
      )
      .then((frames) => sendResponse({ frames }))
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'collect-html') {
    chrome.tabs.sendMessage(msg.tabId, { type: 'tyd-collect-html' }, { frameId: 0 })
      .then((result) => sendResponse({ html: result?.html || '' }))
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  // 做题：汇总各框架的页面文本（默认含中文）。与 translate-frames 同一套逐框架定向收发，
  // 同样要滤掉浏览器内部框架和我们自己注入的抽屉 iframe。
  if (msg.type === 'collect-text') {
    const all = msg.all !== false;
    chrome.webNavigation
      .getAllFrames({ tabId: msg.tabId })
      .then((frames) =>
        Promise.all(
          (frames || [])
            .filter((f) => !/^(chrome|chrome-extension|chrome-error|edge|devtools|view-source|data):/i.test(f.url || ''))
            .map(async (f) => {
              try {
                const r = await chrome.tabs.sendMessage(
                  msg.tabId,
                  { type: 'tyd-collect-text', all },
                  { frameId: f.frameId }
                );
                return r || { texts: [], chars: 0, truncated: false };
              } catch {
                return { texts: [], chars: 0, truncated: false };
              }
            })
        )
      )
      .then((framesData) => {
        // Qwen 运行时设为 8192 tokens，关闭 thinking 直接生成答案；
        // 页面原文总预算约 28000 字符，录音文本由服务端额外优先保留。
        const MAX_SOLVE_PAGE_CHARS = 28000;
        const texts = [];
        const seen = new Set();
        let collectedChars = 0;
        let submittedChars = 0;
        let truncated = framesData.some((x) => x.truncated);

        outer: for (const frame of framesData) {
          collectedChars += Number(frame.chars || 0);
          for (const t of (frame.texts || [])) {
            const k = (t || '').trim();
            if (!k || seen.has(k)) continue;
            seen.add(k);
            if (submittedChars + k.length > MAX_SOLVE_PAGE_CHARS) {
              const left = MAX_SOLVE_PAGE_CHARS - submittedChars;
              if (left > 20) texts.push(k.slice(0, left));
              submittedChars = MAX_SOLVE_PAGE_CHARS;
              truncated = true;
              break outer;
            }
            texts.push(k);
            submittedChars += k.length + 1;
          }
        }
        sendResponse({ texts, collectedChars, submittedChars, truncated });
      })
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }
});

// 快捷键 Ctrl+Shift+Y 唤出侧边栏
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'open-panel') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (!tab?.id) return;
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});
