/* 听译答 · 网页悬浮入口
 *
 * 交互参照会译那类插件：
 *  - 右侧一个悬浮球，点开是「浮动工具卡」（不是整条侧边抽屉）；
 *  - 工具卡可拖动、可收起，尺寸固定在 392px 左右，不占满屏；
 *  - AI 解答单独一个可拖动窗口，和工具卡互相独立：收起工具卡、拖动任何一边都不影响另一边。
 *
 * 用 Shadow DOM 是为了不被网页样式污染，也不污染网页。
 */

(function () {
  if (window.__tydLauncherInjected) return;
  window.__tydLauncherInjected = true;

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
      z-index: 2147483645;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transition: right .18s ease, opacity .18s;
    }
    .fab:hover { background: #0c447c; }
    .fab.hide { right: -60px; opacity: 0; pointer-events: none; }

    /* ---------- 浮动工具卡 ---------- */
    .panel {
      position: fixed;
      right: 64px;
      top: 50%;
      transform: translateY(-50%) scale(.97);
      width: 392px;
      height: min(620px, 86vh);
      display: flex;
      flex-direction: column;
      background: #fff;
      border: 1px solid rgba(15, 40, 70, .12);
      border-radius: 14px;
      box-shadow: 0 12px 34px rgba(12, 40, 70, .22);
      overflow: hidden;
      opacity: 0;
      pointer-events: none;
      transition: opacity .16s ease, transform .16s ease;
      z-index: 2147483647;
      font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .panel.open { opacity: 1; pointer-events: auto; transform: translateY(-50%) scale(1); }
    .panel.dragging, .answer.dragging { transition: none; }

    .head {
      height: 34px;
      flex: 0 0 34px;
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 0 6px 0 10px;
      background: #f4f8fd;
      border-bottom: 1px solid #e4edf8;
      cursor: move;
      user-select: none;
    }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #378add; }
    .name { font-weight: 600; color: #0c447c; font-size: 12.5px; }
    .grow { flex: 1 1 auto; }
    .ic {
      width: 22px; height: 22px;
      border: none; background: transparent;
      color: #5b6b7d; border-radius: 6px;
      cursor: pointer; font-size: 14px; line-height: 1;
      display: inline-flex; align-items: center; justify-content: center;
      padding: 0;
    }
    .ic:hover { background: #e2ecf9; color: #0c447c; }

    .panel iframe {
      flex: 1 1 auto;
      width: 100%;
      border: none;
      display: block;
      background: #fff;
    }

    /* ---------- 独立解答窗口 ---------- */
    .answer {
      position: fixed;
      width: 430px;
      max-height: 74vh;
      display: none;
      flex-direction: column;
      background: #fff;
      border: 1px solid rgba(15, 40, 70, .12);
      border-radius: 12px;
      box-shadow: 0 14px 38px rgba(12, 40, 70, .24);
      overflow: hidden;
      z-index: 2147483646;
      font: 13px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .answer.open { display: flex; }
    .answer .body {
      padding: 10px 12px 12px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      color: #1f2937;
    }
    .answer .meta {
      flex: 0 0 auto;
      padding: 0 12px 8px;
      color: #7b8794;
      font-size: 11.5px;
    }
  `;
  shadow.appendChild(style);

  /* ---------- 工具卡 ---------- */
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML =
    '<div class="head" id="tydHead">' +
    '<span class="dot"></span><span class="name">听译答</span><span class="grow"></span>' +
    '<button class="ic" id="tydMin" title="收起">×</button>' +
    '</div>';

  const frame = document.createElement('iframe');
  // display-capture / microphone 必须显式授权，否则卡里的录制会被 Permissions Policy 拦掉
  frame.setAttribute('allow', 'microphone *; display-capture; autoplay; clipboard-read; clipboard-write');
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
  frame.src = PANEL_URL;
  panel.appendChild(frame);

  /* ---------- 独立解答窗口 ---------- */
  const ans = document.createElement('div');
  ans.className = 'answer';
  ans.innerHTML =
    '<div class="head" id="tydAnsHead">' +
    '<span class="dot"></span><span class="name">解答</span><span class="grow"></span>' +
    '<button class="ic" id="tydAnsCopy" title="复制解答">⧉</button>' +
    '<button class="ic" id="tydAnsClose" title="关闭">×</button>' +
    '</div>' +
    '<div class="body" id="tydAnsBody"></div>' +
    '<div class="meta" id="tydAnsMeta"></div>';

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
  shadow.appendChild(ans);
  shadow.appendChild(fab);
  (document.body || document.documentElement).appendChild(host);

  /* ---------- 拖动 ---------- */
  function draggable(el, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, moving = false;

    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const r = el.getBoundingClientRect();
      moving = true;
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      el.style.left = r.left + 'px';
      el.style.top = r.top + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.style.transform = 'none';
      el.classList.add('dragging');
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!moving) return;
      const w = el.offsetWidth;
      const maxL = Math.max(8, window.innerWidth - w - 8);
      const maxT = Math.max(8, window.innerHeight - 48);
      el.style.left = Math.min(maxL, Math.max(8, ox + e.clientX - sx)) + 'px';
      el.style.top = Math.min(maxT, Math.max(8, oy + e.clientY - sy)) + 'px';
    });

    window.addEventListener('mouseup', () => {
      if (!moving) return;
      moving = false;
      el.classList.remove('dragging');
    });
  }

  draggable(panel, panel.querySelector('#tydHead'));
  draggable(ans, ans.querySelector('#tydAnsHead'));

  /* ---------- 开关 ---------- */
  let opened = false;
  function toggle(state) {
    opened = state === undefined ? !opened : state;
    panel.classList.toggle('open', opened);
    fab.classList.toggle('hide', opened);
  }
  fab.onclick = () => toggle();
  panel.querySelector('#tydMin').onclick = () => toggle(false);
  ans.querySelector('#tydAnsClose').onclick = () => ans.classList.remove('open');

  /* ---------- 解答窗口：由卡片里的 iframe 通知 ---------- */
  const ansBody = ans.querySelector('#tydAnsBody');
  const ansMeta = ans.querySelector('#tydAnsMeta');

  function showAnswer(text, meta) {
    if (!text) return;
    ansBody.textContent = text;
    ansMeta.textContent = meta || '';
    if (!ans.dataset.placed) {
      const r = panel.getBoundingClientRect();
      const left = opened && r.width ? r.left - 446 : 24;
      ans.style.left = Math.max(8, left) + 'px';
      ans.style.top = Math.max(8, opened && r.width ? r.top : 80) + 'px';
      ans.dataset.placed = '1';
    }
    ans.classList.add('open');
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.source !== 'tyd-panel') return;
    if (d.kind === 'answer') showAnswer(d.text, d.meta);
  });

  ans.querySelector('#tydAnsCopy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(ansBody.textContent || '');
      ansMeta.textContent = '已复制';
    } catch {
      ansMeta.textContent = '复制失败，请手动选中';
    }
  };

  /* ---------- 显示/隐藏悬浮球 ---------- */
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

  // 工具栏图标点按时，后台会让我们把卡片打开
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'tyd-toggle-panel') {
      toggle(true);
      try { sendResponse({ ok: true }); } catch (e) { /* ignore */ }
    }
  });

  // Esc：先关解答窗口，再关工具卡
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (ans.classList.contains('open')) {
      ans.classList.remove('open');
    } else if (opened) {
      toggle(false);
    }
  });

  // 上报“我已在这个页面就位”，侧边栏能看到，形成验证闭环
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
