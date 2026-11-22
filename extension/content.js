/* 听译答 助手 · 网页翻译注入脚本
 * 收集页面上的英文文本 -> 调本地服务批量翻译 -> 在原文下方插入中文
 *
 * 这个脚本会被注入到标签页的「每一个框架」，因此里面所有逻辑都必须是
 * 框架局部的：标记用 window.*（每个框架各有一份），不要假设自己在顶层。
 */

(function () {
  if (window.__tydContentInjected) return;
  window.__tydContentInjected = true;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT',
    'CODE', 'PRE', 'SVG', 'CANVAS', 'TITLE', 'HEAD'
  ]);
  // 网页翻译按节点限额，避免一次翻译请求量爆炸。
  // AI 做题不能共用这个 150 节点上限，否则长题目会从中间被静默截断；
  // 做题改用独立字符预算，最终还会在 background / server 两层按模型上下文兜底。
  const MAX_TRANSLATE_NODES = 150;
  const MAX_SOLVE_CHARS_PER_FRAME = 60000;
  const BATCH = 10;

  const isTop = window.top === window;

  // 1x1 这类追踪/隐藏 iframe 不该浪费翻译额度，也不该被计入失败
  function isRuntFrame() {
    if (isTop) return false;
    const de = document.documentElement;
    if (!de) return true;
    const r = de.getBoundingClientRect();
    return r.width < 30 || r.height < 30;
  }

  function englishOnly(t) {
    return String(t || '')
      .replace(/[^\p{Script=Latin}0-9\p{P}\p{Sm}\s]/gu, ' ')
      .replace(/[\u3000-\u303f\uff00-\uffef]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function hasEnglish(t) {
    return /[A-Za-z]/.test(t) && (t.match(/[A-Za-z]{2,}/g) || []).length >= 1;
  }

  function displayOf(el) {
    try {
      return getComputedStyle(el).display || '';
    } catch {
      return '';
    }
  }

  // 行内元素里塞 block 译文，浏览器会生成匿名块盒把行内元素从中间劈开，
  // 译文就和原文错位、相互压住。inline-block 也一样（比如 <button>），
  // 译文会把按钮撑变形，所以一并提升。
  function isInlineEl(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'BODY' || tag === 'HTML') return false;
    return displayOf(el).indexOf('inline') === 0;
  }

  function isFlexGrid(el) {
    if (!el) return false;
    const d = displayOf(el);
    return d === 'flex' || d === 'inline-flex' || d === 'grid' || d === 'inline-grid';
  }

  function resolveAnchor(textNode) {
    let node = textNode;
    let parent = node.parentElement;
    let guard = 0;
    while (parent && guard++ < 20) {
      const gp = parent.parentElement;

      // ① 行内父元素：译文会把父元素劈开 → 提到父元素后面
      if (isInlineEl(parent)) {
        node = parent;
        parent = gp;
        continue;
      }

      // ② 父元素是某个 flex/grid 容器的 item：译文塞进它内部会被压成窄列，
      //    和原文挤在同一行 → 先提到 flex/grid 那一层
      if (gp && isFlexGrid(gp) && !isFlexGrid(parent)) {
        node = parent;
        parent = gp;
        continue;
      }

      // ③ 父元素本身就是 flex/grid 容器：译文进去会变成 item。
      //    实测即使加了 flex:0 0 100%，因为容器默认 nowrap，两个译文还是会
      //    排在同一行并溢出容器（宽度 600 的容器里译文被挤到 x=748）。
      //    最稳妥的做法是整块放到容器后面。
      if (isFlexGrid(parent)) {
        node = parent;
        parent = parent.parentElement;
        continue;
      }

      break;
    }
    return { parent, after: node };
  }

  // ---------- 页面文本提取：按「块」而不是按文本节点 ----------
  // 参考会译那类插件的做法：一个段落一个块，覆盖 shadow DOM，
  // 避免同一句话被行内标签切成碎片、译出来断断续续。

  const TABLE_CELLS = new Set(['TD', 'TH', 'DT', 'DD']);
  const MAX_BLOCK_CHARS = 1600;

  function cleanText(t) {
    return String(t || '').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
  }

  // display:contents 的元素自身没有盒子，但子内容照常渲染，不能因为 rect=0 就丢掉
  function isRendered(el) {
    if (!el) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (parseFloat(s.opacity || '1') === 0) return false;
    if (s.display === 'contents') return true;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function isBlockLike(el) {
    const d = displayOf(el);
    return d === 'block' || d === 'flow-root' || d === 'list-item' ||
           d === 'flex' || d === 'grid' || d === 'table' || d === 'table-row' ||
           d === 'table-cell' || d === 'table-caption';
  }

  function skipEl(el) {
    if (!el || !el.tagName) return true;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.isContentEditable) return true;
    if (el.getAttribute && (el.getAttribute('translate') === 'no' ||
                            el.getAttribute('aria-hidden') === 'true')) return true;
    if (el.classList && el.classList.contains('notranslate')) return true;
    if (el.closest && el.closest('.tyd-tr')) return true;
    return false;
  }

  // document + 所有 shadow root（很多文档站/考试系统把正文放在 shadow DOM 里）
  function eachRoot(fn) {
    const visit = (root) => {
      fn(root);
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of all) if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(document);
  }

  // 只要子孙里还有“带文本的块级元素”，自己就是容器，交给最内层去翻。
  // 必须递归：table > tbody > tr > td 里 tbody 的 display 是 table-row-group，
  // 只查一层会把 <table> 当成叶子，译文就跑到表格外面去了。
  function hasBlockChildWithText(el) {
    const walk = (node) => {
      for (const child of node.children) {
        if (skipEl(child)) continue;
        if (isBlockLike(child) && cleanText(child.innerText || child.textContent).length >= 2) return true;
        if (walk(child)) return true;
      }
      return false;
    };
    return walk(el);
  }

  function hasTranslation(el) {
    if (TABLE_CELLS.has(el.tagName) || el.tagName === 'LI') {
      for (const c of el.children) {
        if (c.classList && c.classList.contains('tyd-tr')) return true;
      }
      return false;
    }
    let n = el.nextSibling;
    while (n && n.nodeType === 3 && !n.nodeValue.trim()) n = n.nextSibling;
    return !!(n && n.nodeType === 1 && n.classList && n.classList.contains('tyd-tr'));
  }

  function collect() {
    const out = [];
    const seen = new Set();

    eachRoot((root) => {
      if (out.length >= MAX_TRANSLATE_NODES) return;
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of all) {
        if (out.length >= MAX_TRANSLATE_NODES) break;
        if (skipEl(el) || !isBlockLike(el)) continue;
        if (hasBlockChildWithText(el)) continue;
        if (!isRendered(el)) continue;
        if (hasTranslation(el)) continue;

        const raw = cleanText(el.innerText || el.textContent);
        if (raw.length < 4 || raw.length > MAX_BLOCK_CHARS) continue;

        const en = englishOnly(raw);
        if (!hasEnglish(en) || seen.has(en)) continue;
        seen.add(en);
        out.push({ el, text: en });
      }
    });

    if (!out.length) return collectByTextNode();
    return out;
  }

  // 兜底：整页没有块级文本时，退回按文本节点聚合的老做法
  function collectByTextNode() {
    if (!document.body) return [];

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const filtered = englishOnly(node.nodeValue || '');
        if (filtered.length < 4 || !hasEnglish(filtered)) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p || skipEl(p)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const groups = new Map();
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.parentElement || !isRendered(node.parentElement)) continue;

      const anchor = resolveAnchor(node);
      if (!anchor.parent || hasTranslation(anchor.after)) continue;

      let g = groups.get(anchor.after);
      if (!g) {
        g = { el: anchor.after, texts: [] };
        groups.set(anchor.after, g);
      }
      g.texts.push(englishOnly(node.nodeValue));
      if (groups.size >= MAX_TRANSLATE_NODES) break;
    }

    return Array.from(groups.values()).map((g) => ({ el: g.el, text: g.texts.join(' ') }));
  }

  // 只为「做题」服务：把本框架的可见文本抽出来交给大模型。
  // all=true 时全语种（含中文）；all=false 时退回只收英文（旧行为）。
  // 与 collect() 的区别：collect() 会跳过已经插入过译文的节点（只翻未翻的），
  // 而做题要的是题目原文，即使页面已经翻译过也要拿到，所以这里不做那层过滤。
  function collectText(all) {
    if (!document.body) return { texts: [], chars: 0, truncated: false };

    const clean = all ? cleanText : englishOnly;
    const useful = all
      ? (t) => /[A-Za-z\u4e00-\u9fff]/.test(t)
      : hasEnglish;

    const out = [];
    let chars = 0;
    let truncated = false;

    eachRoot((root) => {
      if (truncated) return;
      const scope = root === document ? document.body : root;
      if (!scope) return;

      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const text = clean(node.nodeValue || '');
          if (text.length < (all ? 2 : 4)) return NodeFilter.FILTER_REJECT;
          if (!useful(text)) return NodeFilter.FILTER_REJECT;
          const p = node.parentElement;
          if (!p || skipEl(p)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });

      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.parentElement || !isRendered(node.parentElement)) continue;
        const text = clean(node.nodeValue);
        if (!useful(text)) continue;
        if (chars + text.length > MAX_SOLVE_CHARS_PER_FRAME) {
          const left = MAX_SOLVE_CHARS_PER_FRAME - chars;
          if (left > 20) out.push(text.slice(0, left));
          chars = MAX_SOLVE_CHARS_PER_FRAME;
          truncated = true;
          break;
        }
        out.push(text);
        chars += text.length + 1;
      }
    });

    return { texts: out, chars, truncated };
  }

  async function translateBatch(texts, apiBase) {
    // 不自己 fetch：网页侧的 CSP 和浏览器私有网络策略会挡住 127.0.0.1 的请求，
    // 交给 background 代发更稳
    const data = await chrome.runtime.sendMessage({
      target: 'background',
      type: 'translate-batch',
      texts,
      apiBase
    });
    if (!data) throw new Error('本地服务没有响应');
    if (data.error) throw new Error(data.error);
    return data.translations || [];
  }

  // 译文块插在哪：表格单元格 / 列表项插到内部（插到外面会破坏表格与列表结构），
  // 其余块级元素插到元素后面，独占一行。
  function insert(item, zh) {
    const el = item && item.el;
    if (!el) return;
    const box = document.createElement('div');
    box.className = 'tyd-tr';
    box.setAttribute('data-tyd', '1');
    box.textContent = zh;

    if (TABLE_CELLS.has(el.tagName) || el.tagName === 'LI') {
      el.appendChild(box);
      return;
    }
    if (el.parentNode) el.parentNode.insertBefore(box, el.nextSibling);
  }

  async function runTranslate(apiBase) {
    if (isRuntFrame()) {
      return { count: 0, skipped: 'runt', top: isTop, url: location.href };
    }

    const nodes = collect();
    if (!nodes.length) {
      return { count: 0, error: null, top: isTop, url: location.href };
    }

    let done = 0;
    for (let i = 0; i < nodes.length; i += BATCH) {
      const slice = nodes.slice(i, i + BATCH);
      let zhs = [];
      try {
        zhs = await translateBatch(slice.map((n) => n.text), apiBase);
      } catch (e) {
        return { count: done, error: `翻译中断：${e.message}`, top: isTop, url: location.href };
      }
      slice.forEach((item, k) => {
        const zh = (zhs[k] || '').trim();
        if (zh && zh !== item.text) {
          insert(item, zh);
          done++;
        }
      });
    }
    return { count: done, top: isTop, url: location.href };
  }

  function clear() {
    eachRoot((root) => {
      if (root.querySelectorAll) root.querySelectorAll('.tyd-tr').forEach((el) => el.remove());
    });
    return { ok: true, top: isTop };
  }

  // 暴露给扩展内部调用：sidepanel 用 executeScript 逐框架触发并收集结果，
  // 比 chrome.tabs.sendMessage（只回第一个响应）更适合多框架场景
  window.__tydRunTranslate = runTranslate;
  window.__tydClear = clear;
  // 做题用：返回文本 + 字符数 + 是否达到本框架预算；all 默认 true（含中文）
  window.__tydCollectText = function (all) {
    if (isRuntFrame()) return { texts: [], chars: 0, truncated: false };
    return collectText(all !== false);
  };
  window.__tydCollectHtml = function () {
    return isTop ? (document.documentElement?.outerHTML || "") : "";
  };
  window.__tydFrameInfo = function () {
    return {
      top: isTop,
      url: location.href,
      runt: isRuntFrame(),
      hasBody: !!document.body
    };
  };

  // 保留消息通道，便于手动调试与旧调用方
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'tyd-translate') {
      runTranslate(msg.apiBase || 'http://127.0.0.1:8765')
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ count: 0, error: e.message }));
      return true;
    }
    if (msg && msg.type === 'tyd-clear') {
      sendResponse(clear());
      return true;
    }
    if (msg && msg.type === 'tyd-collect-text') {
      try {
        sendResponse(window.__tydCollectText(msg.all));
      } catch (e) {
        sendResponse({ texts: [], chars: 0, truncated: false, error: String(e.message || e) });
      }
      return true;
    }
    if (msg && msg.type === 'tyd-collect-html') {
      try {
        sendResponse({ html: window.__tydCollectHtml() });
      } catch (e) {
        sendResponse({ error: String(e.message || e) });
      }
      return true;
    }
  });
})();
