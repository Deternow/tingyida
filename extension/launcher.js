/* 听译答 · 网页悬浮入口
 *
 * 常驻注入到每个页面：右侧一个悬浮球，点击弹出抽屉，
 * 抽屉里用 iframe 加载 sidepanel.html —— 也就是完整的插件界面。
 *
 * 这样不依赖 Chrome 侧边栏是否固定，打开网页就能用。
 * 用 Shadow DOM 是为了不被任何网页样式污染，也不污染网页。
 */

(function () {
  if (window.__tydLauncherInjected) return;
  window.__tydLauncherInjected = true;
  console.log('[听译答] launcher injected on', location.href);

  const PANEL_URL = chrome.runtime.getURL('sidepanel.html');

  const host = document.createElement('div');
  host.id = 'tyd-launcher-root';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    .fab {
      position: fixed;
      right: 10px;
      top: 50%;
      transform: translateY(-50%);
      width: 44px;
      height: 44px;
      border: none;
      border-radius: 50%;
      background: #185fa5;
      box-shadow: 0 2px 8px rgba(0,0,0,.28);
      cursor: pointer;
      z-index: 2147483646;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transition: right .18s ease, opacity .18s;
    }
    .fab:hover { background: #0c447c; }
    .fab.hide { right: -60px; opacity: 0; pointer-events: none; }
    .panel {
      position: fixed;
      top: 0;
      right: 0;
      width: 400px;
      max-width: 92vw;
      height: 100%;
      background: #fff;
      box-shadow: -4px 0 18px rgba(0,0,0,.18);
      transform: translateX(100%);
      transition: transform .2s ease;
      z-index: 2147483647;
    }
    .panel.open { transform: translateX(0); }
    .panel iframe {
      width: 100%;
      height: 100%;
      border: none;
      display: block;
      background: #fff;
    }
    .close {
      position: absolute;
      left: -30px;
      top: 12px;
      width: 26px;
      height: 26px;
      border: none;
      border-radius: 50%;
      background: #185fa5;
      color: #fff;
      font-size: 15px;
      line-height: 1;
      cursor: pointer;
      box-shadow: 0 2px 6px rgba(0,0,0,.25);
    }
    .close:hover { background: #0c447c; }
  `;
  shadow.appendChild(style);

  const panel = document.createElement('div');
  panel.className = 'panel';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'close';
  closeBtn.title = '收起';
  closeBtn.textContent = '×';
  closeBtn.onclick = () => toggle(false);
  panel.appendChild(closeBtn);

  const frame = document.createElement('iframe');
  // display-capture / microphone 必须显式授权，否则抽屉里的录制会被 Permissions Policy 拦掉
  frame.setAttribute('allow', 'microphone *; display-capture; autoplay; clipboard-read; clipboard-write');
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
  frame.src = PANEL_URL;
  panel.appendChild(frame);

  const fab = document.createElement('button');
  fab.className = 'fab';
  fab.title = '听译答：语音转写 / 翻译 / 做题';
  fab.innerHTML =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path>' +
    '<path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line>' +
    '</svg>';

  shadow.appendChild(panel);
  shadow.appendChild(fab);
  (document.body || document.documentElement).appendChild(host);

  let opened = false;
  function toggle(state) {
    opened = state === undefined ? !opened : state;
    panel.classList.toggle('open', opened);
    fab.classList.toggle('hide', opened);
  }

  fab.onclick = () => toggle();

  // 状态记忆 + 面板内的「隐藏悬浮球」开关
  function applyVisibility(visible) {
    host.style.display = visible ? '' : 'none';
    if (!visible) toggle(false);
  }

  chrome.storage.local.get(['fabVisible'], (d) => {
    applyVisibility(d.fabVisible !== false);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'fabVisible' in changes) {
      applyVisibility(changes.fabVisible.newValue !== false);
    }
  });

  // Esc 收起
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && opened) toggle(false);
  });

  // 上报"我已在这个页面就位"，侧边栏能看到，形成验证闭环
  try {
    chrome.storage.local.get(['fabPages'], (d) => {
      const pages = d && d.fabPages && typeof d.fabPages === 'object' ? d.fabPages : {};
      pages[location.host || location.pathname.slice(0, 40) || 'local'] = Date.now();
      const recent = Object.entries(pages).sort((a, b) => b[1] - a[1]).slice(0, 8);
      chrome.storage.local.set({ fabPages: Object.fromEntries(recent) });
    });
  } catch (e) {
    // storage 不可用就算了，不影响悬浮球
  }
})();
