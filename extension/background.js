// 听译答 助手 · service worker
// 职责：侧边栏唤起 / 翻译请求代理 / 权限与 CSP 规则集管理

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    // 不再用浏览器侧边栏：点图标改为在页面里弹出浮动卡片
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  }
});

chrome.runtime.onStartup?.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  }
  restoreCspBypass();
});

// 打开页面内的浮动卡片（会译那种「按钮 + 浮动卡」，不是浏览器侧边栏）
// 若页面是扩展重载前打开的，内容脚本不在，就现场注入一次 launcher.js 再唤起
async function openFloatPanel(tab) {
  if (!tab?.id) return false;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'tyd-toggle-panel' });
    return true;
  } catch (e) {
    // 内容脚本没就位，下面补注入
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['launcher.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'tyd-toggle-panel' });
    return true;
  } catch (e) {
    return false;
  }
}

// 点工具栏图标：优先浮动卡；chrome:// / 商店页这类注入不了的页面才退回侧边栏
chrome.action.onClicked.addListener(async (tab) => {
  if (await openFloatPanel(tab)) return;
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

// 汇总某个标签页所有框架里的文本；translate / collect-text / solve-page 共用
function collectTabText(tabId, all = true) {
  return chrome.webNavigation
    .getAllFrames({ tabId })
    .then((frames) =>
      Promise.all(
        (frames || [])
          .filter((f) => !/^(chrome|chrome-extension|chrome-error|edge|devtools|view-source|data):/i.test(f.url || ''))
          .map(async (f) => {
            try {
              const r = await chrome.tabs.sendMessage(
                tabId,
                { type: 'tyd-collect-text', all },
                { frameId: f.frameId }
              );
              return r || { texts: [], chars: 0, truncated: false };
            } catch (e) {
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
        for (const t of frame.texts || []) {
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
      return { texts, collectedChars, submittedChars, truncated };
    });
}

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
    collectTabText(msg.tabId, msg.all !== false)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  // 页面按钮「做题」：收集文本后直接请求本地服务，结果由网页里的独立解答窗展示
  if (msg.type === 'solve-page') {
    (async () => {
      // 网页悬浮按钮不带 tabId，用消息来源补上
      const tabId = msg.tabId || (sender && sender.tab && sender.tab.id);
      if (!tabId) {
        sendResponse({ error: '拿不到当前标签页' });
        return;
      }
      const r = await collectTabText(tabId, true);
      const page = (r.texts || []).join('\n').trim();
      if (!page) {
        sendResponse({ error: '页面上没有可作答的文字' });
        return;
      }
      const cfg = await chrome.storage.local.get(['apiBase', 'solveMode']);
      const apiBase = (cfg.apiBase || 'http://127.0.0.1:8765').replace(/\/$/, '');
      const mode = cfg.solveMode === 'cloud' ? 'cloud' : 'local';
      const resp = await fetch(`${apiBase}/api/${mode === 'cloud' ? 'cloud-solve' : 'solve'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page, transcript: '', question: '' }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        sendResponse({ error: data.error || `本地服务返回 ${resp.status}` });
        return;
      }
      sendResponse({ ...data, mode, page_chars: page.length });
    })().catch((e) => sendResponse({ error: e.message || String(e) }));
    return true;
  }

});

// 快捷键 Ctrl+Shift+Y：同样唤出页面内浮动卡，注入失败才退回侧边栏
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'open-panel') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (!tab?.id) return;
  if (await openFloatPanel(tab)) return;
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});
