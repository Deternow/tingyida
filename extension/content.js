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

  function isVisible(el) {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    if (parseFloat(s.opacity || '1') === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
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

  function hasTranslationAfter(anchor) {
    let n = anchor.after ? anchor.after.nextSibling : null;
    while (n && n.nodeType === 3 && !n.nodeValue.trim()) n = n.nextSibling;
    return !!(n && n.nodeType === 1 && n.classList && n.classList.contains('tyd-tr'));
  }

  function collect() {
    if (!document.body) return [];

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const raw = node.nodeValue || '';
        const filtered = englishOnly(raw);
        if (filtered.length < 4) return NodeFilter.FILTER_REJECT;
        if (!hasEnglish(filtered)) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest('.tyd-tr')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    // 同一个行内元素（比如一个 <a> 链接）里的多个文本节点会解析到同一个插入点。
    // 按插入点聚合成一条译文，否则会在同一位置堆出好几个译文块、互相压住。
    const groups = new Map();
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!isVisible(node.parentElement)) continue;

      const anchor = resolveAnchor(node);
      if (!anchor.parent) continue;
      if (hasTranslationAfter(anchor)) continue; // 已经翻过

      let g = groups.get(anchor.after);
      if (!g) {
        g = { anchor, texts: [] };
        groups.set(anchor.after, g);
      }
      const english = englishOnly(node.nodeValue);
      if (hasEnglish(english)) g.texts.push(english);
      if (groups.size >= MAX_TRANSLATE_NODES) break;
    }

    return Array.from(groups.values()).map((g) => ({
      anchor: g.anchor,
      text: g.texts.join(' ')
    }));
  }

  // 只为「做题」服务：把本框架的可见文本抽出来交给大模型。
  // all=true 时全语种（含中文）；all=false 时退回只收英文（旧行为）。
  // 与 collect() 的区别：collect() 会跳过已经插入过译文的节点（只翻未翻的），
  // 而做题要的是题目原文，即使页面已经翻译过也要拿到，所以这里不做那层过滤。
  function collectText(all) {
    if (!document.body) return { texts: [], chars: 0, truncated: false };

    const clean = all ? (t) => String(t || '').replace(/\s+/g, ' ').trim() : englishOnly;
    const useful = all
      ? (t) => /[A-Za-z\u4e00-\u9fff]/.test(t)
      : hasEnglish;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = clean(node.nodeValue || '');
        if (text.length < (all ? 2 : 4)) return NodeFilter.FILTER_REJECT;
        if (!useful(text)) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        // 排除我们自己插入的译文块（里面可能夹着英文术语），避免重复计入
        if (p.closest && p.closest('.tyd-tr')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const out = [];
    let chars = 0;
    let truncated = false;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.parentElement || !isVisible(node.parentElement)) continue;
      const text = clean(node.nodeValue);
      if (!useful(text)) continue;
      if (chars + text.length > MAX_SOLVE_CHARS_PER_FRAME) {
        // 保留本节点能放下的前半段，避免恰好把题目选项整块丢掉
        const left = MAX_SOLVE_CHARS_PER_FRAME - chars;
        if (left > 20) out.push(text.slice(0, left));
        chars = MAX_SOLVE_CHARS_PER_FRAME;
        truncated = true;
        break;
      }
      out.push(text);
      chars += text.length + 1;
    }
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

  function insert(anchor, zh) {
    const span = document.createElement('span');
    span.className = 'tyd-tr';
    span.setAttribute('data-tyd', '1');
    span.textContent = zh;
    const { parent, after } = anchor;
    if (!parent) return;
    if (after.nextSibling) parent.insertBefore(span, after.nextSibling);
    else parent.appendChild(span);
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
          insert(item.anchor, zh);
          done++;
        }
      });
    }
    return { count: done, top: isTop, url: location.href };
  }

  function clear() {
    document.querySelectorAll('.tyd-tr').forEach((el) => el.remove());
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
