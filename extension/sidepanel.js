/* 听译答 · 侧边栏主逻辑
 * 录音 -> WAV(16k/单声道) -> 本地服务 /api/transcribe -> Vosk 识别
 * 识别文本 / 网页英文 -> 本地服务 /api/translate -> 中文
 */

const DEFAULT_API = 'http://127.0.0.1:8765';
const SAMPLE_RATE = 16000;

let API = DEFAULT_API;
let history = [];
let selectedId = null;
const solveSelectedIds = new Set();

// 云端配置状态（只记是否已存密钥与模型名，密钥本身不落到扩展里）
let cloudConfigured = false;
let cloudModelName = '';
// 本地模型状态：null=未知（按可用处理），false=确实不可用
let localAvailable = null;
let localModelName = '';
let localReason = '';

let recording = false;
let systemMode = false;   // 音源=整个电脑时走本地服务录制，不弹浏览器窗
let startedAt = 0;
let timerId = null;
// 实时音量由 offscreen 推过来，不再在本地算

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 工具

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function fmtClock(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
         `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function setMsg(el, text, kind = '') {
  el.className = `msg ${kind}`;
  el.textContent = text || '';
}

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------------------------------------------------------------- 服务状态

async function checkStatus() {
  const el = $('status');
  el.className = 'status';
  el.textContent = '检测中…';
  try {
    const s = await api('/api/status');
    const asr = Object.entries(s.asr_models || {}).filter(([, v]) => v).map(([k]) => k);
    const tr = s.translation_installed ? '翻译已就绪' : '翻译缺失';
    const qw = s.qwen || {};
    localAvailable = !!qw.installed;
    localModelName = qw.model || '';
    localReason = qw.reason || '';
    if (s.cloud) {
      cloudConfigured = !!s.cloud.configured;
      if (s.cloud.model) cloudModelName = s.cloud.model;
    }
    el.className = 'status on';
    const solve = localAvailable ? `本地模型:${localModelName || '就绪'}` : '本地模型缺失';
    el.textContent = `已连接 · ASR:${asr.join('/') || '无'} · ${tr} · ${solve}`;
    await applyLocalAvailability();
    applySolveMode();
  } catch (e) {
    el.className = 'status off';
    el.textContent = '未连接：请先启动本地服务';
    localAvailable = null;   // 状态未知时不禁用本地选项
    applySolveMode();
  }
}

// ---------------------------------------------------------------- 录音


function encodeWAV(samples, rate = SAMPLE_RATE) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const put = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };

  put(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);        // PCM
  view.setUint16(22, 1, true);        // 单声道
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  put(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// ---- 录音：直接在侧边栏采集 ----
// 标签页音源走 getDisplayMedia（弹系统选择框，选「此标签页」并勾「分享标签页音频」）。
// 弃用 tabCapture.getMediaStreamId：它要求扩展在目标标签页上被用户激活（点工具栏图标），
// 从侧边栏按钮触发永远不满足 "Extension has not been invoked" 这个条件。
let captureStream = null;
let audioCtx = null;
let srcNode = null;
let procNode = null;
let chunks = [];

async function resolveStream() {
  const mode = $('source').value;

  if (mode === 'mic') {
    return navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });
  }

  const whole = mode === 'system';

  // Chrome 会拒绝 `preferCurrentTab:true + selfBrowserSurface:'exclude'`：
  // 一边要求优先当前标签页，一边又把当前浏览器页面排除，属于自相矛盾配置。
  // 按音源分别构造，避免把互斥参数拼在同一个三元表达式里。
  const displayOptions = whole
    ? {
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        },
        systemAudio: 'include',
        selfBrowserSurface: 'include',
        surfaceSwitching: 'include',
        preferCurrentTab: false
      }
    : {
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        },
        systemAudio: 'exclude',
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
        preferCurrentTab: true
      };

  const disp = await navigator.mediaDevices.getDisplayMedia(displayOptions);

  const at = disp.getAudioTracks()[0];
  if (!at) {
    disp.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
    throw new Error(whole
      ? '没有拿到系统音频。请在弹窗里选「整个屏幕」，并勾选左下角的「分享系统音频」'
      : '没有拿到音频轨。请在弹窗里选「此标签页」，并勾选底部的「同时分享标签页音频」');
  }

  // 只用声音，把视频采集压到最低，省 CPU
  const vt = disp.getVideoTracks()[0];
  if (vt) {
    try {
      await vt.applyConstraints({ width: { max: 16 }, height: { max: 16 }, frameRate: { max: 1 } });
    } catch (e) {
      // 不支持就保持原样，不影响录音
    }
  }

  captureStream = disp;                      // 停止时统一释放
  return new MediaStream([at]);               // 只把音频轨送进 AudioContext
}

function teardownCapture() {
  if (procNode) { try { procNode.disconnect(); procNode.onaudioprocess = null; } catch (e) {} procNode = null; }
  if (srcNode) { try { srcNode.disconnect(); } catch (e) {} srcNode = null; }
  if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
  if (captureStream) { captureStream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} }); captureStream = null; }
}

async function startRecording() {
  setMsg($('asrMsg'), '');
  const t0 = await getActiveTab();
  lockTab = t0 || null;
  paintTarget();

  systemMode = $('source').value === 'system';

  try {
    if (systemMode) {
      // 整个电脑的声音：交给本地服务直接录回环音频，浏览器不弹窗
      await api('/api/system-record/start', { method: 'POST' });
    } else {
      const stream = await resolveStream();

      chunks = [];
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioCtx({ sampleRate: SAMPLE_RATE });
      srcNode = audioCtx.createMediaStreamSource(stream);
      procNode = audioCtx.createScriptProcessor(4096, 1, 1);

      procNode.onaudioprocess = (e) => {
        const d = e.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(d));
        let sum = 0;
        for (let i = 0; i < d.length; i += 16) sum += d[i] * d[i];
        const rms = Math.sqrt(sum / (d.length / 16));
        $('meterBar').style.width = `${Math.round(Math.min(1, rms * 8) * 100)}%`;
      };
      srcNode.connect(procNode);
      procNode.connect(audioCtx.destination);
    }
  } catch (e) {
    teardownCapture();
    lockTab = null;
    paintTarget();
    const m = e.message || String(e);
    if (/Permission denied|NotAllowedError|denied/i.test(m)) {
      setMsg($('asrMsg'), '已取消，或浏览器 / 系统拒绝了录音权限', 'err');
      return;
    }
    if (/Self-contradictory configuration|preferCurrentTab/i.test(m)) {
      setMsg($('asrMsg'), '标签页录音参数冲突，请重载插件后再试（v2.0.2 已修复）', 'err');
      return;
    }
    // 服务端已经在录（多半是在另一个面板里起的），直接接管它而不是干报错
    if (/已经在录制/i.test(m)) {
      if (await syncServerRecording()) {
        setMsg($('asrMsg'), '本地服务已经在录制，已接管，点「结束录制」即可收尾', 'ok');
        return;
      }
    }
    setMsg($('asrMsg'), `无法开始录制：${m}`, 'err');
    return;
  }

  recording = true;
  startedAt = Date.now();
  $('btnStart').disabled = true;
  $('btnStop').disabled = false;
  $('recState').textContent = '录制中';
  $('recState').className = 'rec-state on';

  startRecTimer();
}

function startRecTimer() {
  clearInterval(timerId);
  if (systemMode) {
    timerId = setInterval(async () => {
      $('timer').textContent = fmtTime((Date.now() - startedAt) / 1000);
      try {
        const st = await api('/api/system-record/status');
        $('meterBar').style.width = `${Math.min(100, Math.round((st.level || 0) * 600))}%`;
      } catch (e) {
        // 查询失败不影响录制
      }
    }, 700);
  } else {
    timerId = setInterval(() => {
      $('timer').textContent = fmtTime((Date.now() - startedAt) / 1000);
    }, 200);
  }
}

// 服务端才是录制状态的唯一权威。侧边栏和悬浮球抽屉是两个独立页面实例，
// 各自的 recording 变量互不相通，所以面板每次醒来都要去服务端对一次表，
// 否则会出现「提示已经在录制、却怎么都停不掉」的死锁。
async function syncServerRecording() {
  try {
    const st = await api('/api/system-record/status');
    if (!st || !st.recording) return false;

    recording = true;
    systemMode = true;
    startedAt = Date.now() - (st.elapsed || 0) * 1000;
    $('btnStart').disabled = true;
    $('btnStop').disabled = false;
    $('recState').textContent = '录制中（已接管）';
    $('recState').className = 'rec-state on';
    startRecTimer();
    return true;
  } catch {
    return false; // 服务没开就别打扰用户
  }
}

function mergeChunks(list) {
  let len = 0;
  for (const c of list) len += c.length;
  const out = new Float32Array(len);
  let o = 0;
  for (const c of list) { out.set(c, o); o += c.length; }
  return out;
}

async function stopRecording(auto = false) {
  // 前端状态丢了、但服务端还在录时，也要能收尾——否则录制会永远卡住
  if (!recording) {
    const st = await api('/api/system-record/status').catch(() => null);
    if (!st || !st.recording) return null;
    recording = true;
    systemMode = true;
    startedAt = Date.now() - (st.elapsed || 0) * 1000;
  }
  recording = false;
  clearInterval(timerId);
  timerId = null;

  const duration = (Date.now() - startedAt) / 1000;

  $('btnStart').disabled = false;
  $('btnStop').disabled = true;
  $('recState').textContent = '待机';
  $('recState').className = 'rec-state';
  $('meterBar').style.width = '0%';
  lockTab = null;
  refreshActiveTab();

  // 系统音频：让本地服务收尾（存盘 + 识别）
  if (systemMode) {
    systemMode = false;
    setMsg($('asrMsg'), '正在保存并识别…');
    try {
      const r = await api('/api/system-record/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lang: $('lang').value,
          transcribe: $('autoTranscribe').checked ? '1' : '0'
        })
      });
      await loadHistory();
      selectedId = r.item.id;
      render();
      if (r.warning || r.item.audio_error) {
        setMsg($('asrMsg'), r.warning || r.item.audio_error, 'err');
      } else {
        setMsg($('asrMsg'), r.item.text
          ? `识别完成（${r.item.lang}，${r.item.cost}s）`
          : '已保存，点「转成文字」进行识别', 'ok');
      }
      return r.item;
    } catch (e) {
      const m = e.message || String(e);
      if (/当前没有在录制/i.test(m)) {
        // worker 可能已经因设备异常自行退出，并顺手把服务端状态清了
        setMsg($('asrMsg'), '服务端这段录制已经不在了（多半是采集设备异常），界面已重置', 'err');
        await loadHistory().catch(() => {});
        render();
      } else {
        setMsg($('asrMsg'), `结束录制失败：${m}`, 'err');
      }
      return null;
    }
  }

  const pcm = mergeChunks(chunks);
  chunks = [];
  teardownCapture();

  if (pcm.length < SAMPLE_RATE * 0.3) {
    setMsg($('asrMsg'), '录音太短（或没抓到声音），已丢弃', 'err');
    return null;
  }

  const wav = encodeWAV(pcm);
  setMsg($('asrMsg'), `录音 ${duration.toFixed(1)}s，正在保存到 recordings/ …`);
  const doTr = auto && $('autoTranscribe').checked;
  const item = await uploadAudio(wav, duration, doTr);
  if (item && !doTr) setMsg($('asrMsg'), '已保存，点「转成文字」进行识别', 'ok');
  return item;
}

async function uploadAudio(wav, duration, doTranscribe) {
  const fd = new FormData();
  fd.append('file', wav, 'record.wav');
  fd.append('duration', String(duration));
  fd.append('transcribe', doTranscribe ? '1' : '0');
  try {
    const r = await api('/api/transcribe', { method: 'POST', body: fd });
    await loadHistory();
    selectedId = r.item.id;
    render();
    return r.item;
  } catch (e) {
    setMsg($('asrMsg'), `上传失败：${e.message}（本地服务是否已启动？）`, 'err');
    return null;
  }
}

// ---------------------------------------------------------------- 识别 / 翻译

async function transcribe(id) {
  const target = id || selectedId || (history[0] && history[0].id);
  if (!target) { setMsg($('asrMsg'), '还没有录音', 'err'); return; }
  setMsg($('asrMsg'), '识别中…');
  try {
    const body = new URLSearchParams();
    body.set('id', target);
    body.set('lang', $('lang').value);
    const r = await api('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    await loadHistory();
    selectedId = target;
    render();
    setMsg($('asrMsg'), r.item.text ? `识别完成（${r.item.lang}，耗时 ${r.item.cost}s）` : '识别完成，但没有听清内容', 'ok');
  } catch (e) {
    setMsg($('asrMsg'), `识别失败：${e.message}`, 'err');
  }
}

async function translateItem(id) {
  const target = id || selectedId || (history[0] && history[0].id);
  if (!target) return;
  setMsg($('asrMsg'), '翻译中…');
  try {
    const r = await api('/api/history/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: target })
    });
    await loadHistory();
    render();
    setMsg($('asrMsg'), '翻译完成', 'ok');
  } catch (e) {
    setMsg($('asrMsg'), `翻译失败：${e.message}`, 'err');
  }
}

async function removeItem(id) {
  await api('/api/history/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  });
  if (selectedId === id) selectedId = null;
  await loadHistory();
    render();
}

// ---------------------------------------------------------------- 做题

async function collectPageText(tabId) {
  // 返回正文和收集统计，让用户知道长页面是否达到上下文预算
  // all: true —— 连中文一起收，中文题目也能作答
  const r = await chrome.runtime
    .sendMessage({ target: 'background', type: 'collect-text', all: true, tabId })
    .catch(() => null);
  const texts = (r && r.texts) || [];
  return {
    text: texts.join('\n').trim(),
    collectedChars: Number((r && r.collectedChars) || 0),
    submittedChars: Number((r && r.submittedChars) || 0),
    truncated: !!(r && r.truncated)
  };
}

async function collectPageHtml(tabId) {
  const r = await chrome.runtime
    .sendMessage({ target: 'background', type: 'collect-html', tabId })
    .catch(() => null);
  if (r && r.error) throw new Error(r.error);
  return String((r && r.html) || '');
}

// 本地模型没装好就把「本地 Qwen」选项置灰并切到云端，避免选了也答不了
async function applyLocalAvailability() {
  const sel = $('solveMode');
  const opt = sel.querySelector('option[value="local"]');
  if (!opt) return;
  const available = localAvailable !== false;   // 未知时不禁用
  opt.disabled = !available;
  opt.textContent = available
    ? `本地 Qwen${localModelName ? `（${localModelName}）` : '（离线）'}`
    : '本地 Qwen（未安装）';
  if (!available && sel.value === 'local') {
    sel.value = 'cloud';
    await chrome.storage.local.set({ solveMode: 'cloud' });
  }
}

// 做题卡片的模型提示：让“本地 / 云端”的选择结果一眼可见
function applySolveMode() {
  const el = $('solveModeHint');
  if (!el) return;
  const mode = $('solveMode').value || 'local';
  el.className = 'hint';
  if (mode === 'cloud') {
    if (cloudConfigured) {
      el.textContent = `云端 API：${cloudModelName || '已保存的模型'}，Key 已保存在本机`;
      if (localAvailable === false) el.textContent += '（未检测到本地模型，只能走云端）';
    } else {
      el.className = 'hint err';
      el.textContent = localAvailable === false
        ? '本地模型未安装，云端也没配置：请运行「安装本地模型.bat」，或在下方「设置」填写 API Key 并保存'
        : '云端还没配置：到下方「设置」填接口地址、模型名称和 API Key，点「保存云端配置」';
    }
  } else {
    el.textContent = '本地 Qwen：只走 127.0.0.1 的 Ollama，不联网';
  }
}

async function solve() {
  const el = $('solveMsg');
  const box = $('solveAnswer');
  const btn = $('btnSolve');

  const tab = await getActiveTab();
  if (!tab) { setMsg(el, '拿不到当前标签页', 'err'); return; }

  btn.disabled = true;
  btn.textContent = '作答中…';
  box.hidden = true;
  setMsg(el, '正在收集页面文本…');

  try {
    const mode = $('solveMode').value || 'local';
    if (mode === 'local' && localAvailable === false) {
      setMsg(el, `本地模型不可用：${localReason || '未安装'}。请运行「安装本地模型.bat」，或把「作答模型」切到云端 API`, 'err');
      return;
    }
    if (mode === 'cloud' && !cloudConfigured && !$('cloudApiKey').value.trim()) {
      const back = localAvailable === false ? '' : '，或把「作答模型」切回本地 Qwen';
      setMsg(el, `云端还没配置 API Key：到下方「设置」填写并保存${back}`, 'err');
      return;
    }
    const pageInfo = await collectPageText(tab.id);
    const page = pageInfo.text;
    // 优先用面板里选中的那条；没选就用最新一条
    const selectedItems = history.filter((x) => solveSelectedIds.has(x.id) && String(x.text || '').trim());
    const solveItems = selectedItems.length
      ? selectedItems.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
      : [history.find((x) => x.id === selectedId) || history[0]].filter(Boolean);
    const transcript = solveItems
      .map((x) => (x.text || '').trim())
      .filter(Boolean)
      .join('\n');

    if (!page && !transcript) {
      setMsg(el, '没有内容可作答：当前页面没收集到文本，也没有已识别的录音文本', 'err');
      return;
    }

    const pageStat = page
      ? `页面 ${pageInfo.submittedChars || page.length} 字${pageInfo.truncated ? '（已达到上下文预算，后部截断）' : ''}`
      : '无页面文本';
    const audioStat = transcript
      ? `录音 ${solveItems.filter((x) => (x.text || '').trim()).length} 条 / ${transcript.length} 字`
      : '无录音文本';
    const payload = { page, transcript, question: ($('solveExtra').value || '').trim() };
    if (mode === 'cloud' && $('cloudSendHtml').checked) {
      setMsg(el, '正在收集页面 HTML…');
      try {
        payload.html = await collectPageHtml(tab.id);
      } catch (e) {
        // 页面还没注入内容脚本时不要让整次作答失败，退化成只发文字
        payload.html = '';
        setMsg(el, `页面 HTML 收集失败（${e.message || e}），本次只发送文字…`);
      }
    }
    setMsg(el, `已收集：${pageStat}；${audioStat}。${mode === 'cloud' ? '云端 API' : '本地模型'}正在作答…`);
    const data = await api(mode === 'cloud' ? '/api/cloud-solve' : '/api/solve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    box.hidden = false;
    box.textContent = data.answer || '（模型没有返回内容）';
    const cut = data.input && data.input.truncated ? '，文字输入已按上下文预算截断' : '';
    const detail = mode === 'cloud'
      ? `页面 ${data.input?.page_chars || 0} 字 / HTML ${data.input?.html_chars || 0} 字`
      : `输入 ${data.input ? data.input.total_chars : page.length + transcript.length} 字`;
    const who = mode === 'cloud' ? `云端 ${cloudModelName || 'API'}` : '本地 Qwen';
    setMsg(el, `作答完成（${who}，${data.cost}s，${detail}${cut}）`, 'ok');
  } catch (e) {
    const message = String(e.message || e).replace(/^做题失败[：: ]*/, '');
    setMsg(el, `做题失败：${message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '做题';
  }
}

// ---------------------------------------------------------------- 网页翻译

let activeTab = null;   // 当前活动标签页（实时跟踪）
let lockTab = null;     // 录制期间锁定，避免中途切页导致目标漂移

function paintTarget() {
  const t = lockTab || activeTab;
  const dot = $('targetDot');
  const name = $('targetTitle');
  if (!t) {
    dot.className = 'target-dot dead';
    name.textContent = '未检测到可用标签页';
    return;
  }
  let host = '';
  try { host = new URL(t.url || '').host; } catch (e) { host = (t.url || '').slice(0, 24); }
  dot.className = 'target-dot live';
  name.textContent = `${t.title || '(无标题)'}${host ? ' · ' + host : ''}${lockTab ? '（录制中已锁定）' : ''}`;
  name.title = t.url || '';
}

async function refreshActiveTab() {
  if (lockTab) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tab || null;
  } catch (e) {
    activeTab = null;
  }
  paintTarget();
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  paintTarget();
  return activeTab;
}

// ---------------------------------------------------------------- 权限

let permCache = { granted: false, cspBypass: false };

async function refreshPerm() {
  try {
    permCache = await chrome.runtime.sendMessage({ target: 'background', type: 'perm-state' });
  } catch {
    permCache = { granted: false, cspBypass: false };
  }
  paintPerm();
  return permCache;
}

// 直接在侧边栏调 permissions.request，不经过 background 转发——
// 转一道会丢掉用户手势，Chrome 会直接拒绝授权弹窗
function requestAllSites() {
  return chrome.permissions
    .request({ origins: ['<all_urls>', 'file://*/*'] })
    .then((ok) => {
      refreshPerm();
      return ok;
    })
    .catch(() => false);
}

function paintPerm() {
  const el = $('permState');
  if (el) {
    el.textContent = permCache.granted
      ? '全站权限：已授予（可翻译 iframe，可绕过 CSP）'
      : '全站权限：未授予（仅能翻译网页主框架）';
    el.className = permCache.granted ? 'hint ok' : 'hint';
  }
  const box = $('cspBypass');
  if (box) {
    box.checked = !!permCache.cspBypass;
    box.disabled = !permCache.granted;
  }
}

// ---------------------------------------------------------------- 注入

async function injectInto(tabId, allFrames) {
  const target = { tabId, allFrames };
  // CSS 注入失败不影响主流程（样式没了只是难看，翻译还能用）
  await chrome.scripting.insertCSS({ target, files: ['content.css'] }).catch(() => {});
  await chrome.scripting.executeScript({ target, files: ['content.js'] });
}

// 逐框架触发并返回每个框架的结果。
// 不用 chrome.tabs.sendMessage：它广播到所有框架但只回第一个响应，
// 多框架场景下拿不到汇总数据。
async function runInFrames(tabId, allFrames, apiBase) {
  return (
    (await chrome.scripting.executeScript({
      target: { tabId, allFrames },
      func: async (base) => {
        try {
          if (typeof window.__tydRunTranslate !== 'function') {
            return { count: 0, skipped: 'not-injected' };
          }
          return await window.__tydRunTranslate(base);
        } catch (e) {
          return { count: 0, error: String((e && e.message) || e) };
        }
      },
      args: [apiBase]
    })) || []
  );
}

function summarize(results) {
  const s = { total: 0, frames: 0, errors: [], runt: 0, blocked: 0 };
  for (const r of results) {
    const v = r.result;
    if (!v) continue;
    if (v.skipped === 'not-injected') { s.blocked++; continue; }
    if (v.skipped === 'runt') { s.runt++; continue; }
    if (v.error) { s.errors.push(v.error); continue; }
    s.frames++;
    s.total += v.count || 0;
  }
  return s;
}

function showPermHint(text) {
  const box = $('permHint');
  if (!box) return;
  $('permHintText').textContent = text;
  box.hidden = false;
}

function hidePermHint() {
  const box = $('permHint');
  if (box) box.hidden = true;
}

// ---------------------------------------------------------------- 网页翻译

// 汇总「逐框架发消息」的回执
function summarizeFrameReplies(frames) {
  const s = { total: 0, frames: 0, errors: [], runt: 0, blocked: 0, dead: 0 };
  for (const f of frames) {
    if (f.error) {
      if (/Receiving end|establish connection/i.test(f.error)) s.dead++;
      else s.errors.push(f.error);
      continue;
    }
    const v = f.result;
    if (!v) continue;
    if (v.skipped === 'not-injected') { s.blocked++; continue; }
    if (v.skipped === 'runt') { s.runt++; continue; }
    if (v.error) { s.errors.push(v.error); continue; }
    s.frames++;
    s.total += v.count || 0;
  }
  return s;
}

// 把「权限不足」翻译成人话，并给出下一步动作
function reportInjectError(el, m) {
  if (/Receiving end|establish connection/i.test(m)) {
    setMsg(el, '这个页面是在插件上次重载之前打开的，刷新一下网页就好', 'err');
  } else if (/Missing host permission|Cannot access/i.test(m)) {
    setMsg(el, '浏览器没给这个页面临时授权。点下面「授权全站权限」，一次搞定所有网站', 'err');
    showPermHint(
      'activeTab 权限只在点过工具栏 听译答 图标的页面生效，从侧边栏点按钮不算。授权全站权限后不再受此限制。'
    );
  } else if (/chrome:|chrome-error|about:|chrome-extension:|edge:/i.test(m)) {
    setMsg(el, '浏览器内部页面（chrome:// 之类）禁止任何插件注入', 'err');
  } else if (/file:/i.test(m)) {
    setMsg(el, '本地 HTML 需要「允许访问文件网址」，点「授权全站权限」即可', 'err');
    showPermHint('file:// 页面需要在扩展详情里单独放行，授权全站权限就包含了这一项。');
  } else {
    setMsg(el, `翻译失败：${m}`, 'err');
  }
}

async function tryInjectFallback(tab, el, perm) {
  try {
    await injectInto(tab.id, perm.granted);
    return summarize(await runInFrames(tab.id, perm.granted, API));
  } catch (e) {
    reportInjectError(el, (e && (e.message || String(e))) || '');
    return null;
  }
}

function reportTranslate(el, s, perm) {
  if (s.errors.length && s.total === 0) {
    setMsg(el, `翻译中断：${s.errors[0]}`, 'err');
    return;
  }
  if (s.total === 0 && s.dead === 0) {
    setMsg(el, '页面上没有找到英文文本', 'err');
    return;
  }
  if (s.total === 0 && s.dead > 0) {
    setMsg(el, '页面脚本还没就位，刷新网页后再试', 'err');
    return;
  }

  let msg = `已翻译 ${s.total} 处英文`;
  if (s.frames > 1) msg += `（覆盖 ${s.frames} 个框架）`;
  if (s.errors.length) msg += `，${s.errors.length} 个框架出错`;
  setMsg(el, msg, 'ok');

  if (s.blocked > 0) {
    showPermHint(`本页有 ${s.blocked} 个跨域框架没权限进入，授权全站权限后可一并翻译`);
  } else if (s.dead > 0 && !perm.granted) {
    showPermHint(`${s.dead} 个框架是页面动态生成的，授权全站权限后可即时补注并翻译`);
  }
}

async function translatePage() {
  const tab = await getActiveTab();
  const el = $('pageMsg');
  if (!tab) return;
  if (tab.url && !/^https?:/i.test(tab.url) && !/^file:/i.test(tab.url)) {
    setMsg(el, '当前页面不支持翻译（浏览器内部页面）', 'err');
    return;
  }

  setMsg(el, '正在扫描页面英文…');
  hidePermHint();

  const perm = await refreshPerm();

  // 链路 1（主）：content.js 已由 manifest 常驻注入到每个框架，
  // 按 frameId 逐个发消息即可 —— 这条路不需要 activeTab，不会报权限不足
  const r = await chrome.runtime
    .sendMessage({ target: 'background', type: 'translate-frames', tabId: tab.id, apiBase: API })
    .catch((e) => ({ error: String(e.message || e) }));

  let s = r && r.frames ? summarizeFrameReplies(r.frames) : null;

  // 链路 2（兜底）：页面在扩展上次重载前就打开了，常驻脚本还没进去，
  // 这时才用 executeScript 补注（需要 activeTab 或全站权限）
  if (!s || (s.frames === 0 && s.dead > 0)) {
    s = await tryInjectFallback(tab, el, perm);
  }

  if (!s) return; // 兜底也失败时，错误提示已经写进 el 了
  reportTranslate(el, s, perm);
}

async function clearPage() {
  const tab = await getActiveTab();
  if (!tab) return;
  try {
    const r = await chrome.runtime
      .sendMessage({ target: 'background', type: 'clear-frames', tabId: tab.id })
      .catch(() => null);
    const allDead = r && r.frames && r.frames.length > 0 && r.frames.every((f) => f.error);
    if (!r || !r.frames || allDead) {
      const perm = permCache.granted;
      await injectInto(tab.id, perm);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: perm },
        func: () => {
          try {
            return window.__tydClear ? window.__tydClear() : { ok: false };
          } catch {
            return { ok: false };
          }
        }
      });
    }
    setMsg($('pageMsg'), '已清除本页译文', 'ok');
  } catch (e) {
    const m = e.message || String(e);
    if (/Receiving end|establish connection/i.test(m)) {
      setMsg($('pageMsg'), '这个页面是在插件重载前打开的，刷新后再试', 'err');
    } else {
      setMsg($('pageMsg'), `清除失败：${m}`, 'err');
    }
  }
}

// ---------------------------------------------------------------- 历史渲染

async function loadHistory() {
  try {
    const d = await api('/api/history');
    history = d.items || [];
    const availableIds = new Set(history.map((item) => item.id));
    for (const id of solveSelectedIds) {
      if (!availableIds.has(id)) solveSelectedIds.delete(id);
    }
  } catch (e) {
    history = [];
  }
  $('histCount').textContent = String(history.length);
}

function render() {
  const box = $('history');
  box.innerHTML = '';
  if (!history.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = '暂无录音。点「开始录制」说话，再点「转成文字」。';
    box.appendChild(p);
    return;
  }

  history.forEach((it, idx) => {
    const div = document.createElement('div');
    div.className = `item ${it.id === selectedId ? 'active' : ''}`;
    div.onclick = () => { selectedId = it.id; render(); };

    const solvePick = document.createElement('label');
    solvePick.className = 'solve-pick';
    solvePick.title = '将此录音识别文本加入做题';
    solvePick.onclick = (e) => e.stopPropagation();
    const solveCheck = document.createElement('input');
    solveCheck.type = 'checkbox';
    solveCheck.checked = solveSelectedIds.has(it.id);
    solveCheck.disabled = !String(it.text || '').trim();
    solveCheck.setAttribute('aria-label', `选择录音 ${history.length - idx} 用于做题`);
    solveCheck.onclick = (e) => e.stopPropagation();
    solveCheck.onchange = () => {
      if (solveCheck.checked) solveSelectedIds.add(it.id);
      else solveSelectedIds.delete(it.id);
    };
    const solveLabel = document.createElement('span');
    solveLabel.textContent = '用于做题';
    solvePick.append(solveCheck, solveLabel);
    div.appendChild(solvePick);

    const head = document.createElement('div');
    head.className = 'item-head';
    head.innerHTML =
      `<span class="tag">#${history.length - idx}</span>` +
      `<span>${fmtClock(it.created_at)}</span>` +
      `<span>${(it.duration || 0).toFixed(1)}s</span>` +
      (it.lang ? `<span class="tag">${it.lang === 'zh' ? '中文' : '英文'}</span>` : '');
    div.appendChild(head);

    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = `${API}/api/audio/${encodeURIComponent(it.audio)}`;
    audio.onclick = (e) => e.stopPropagation();
    div.appendChild(audio);

    const t1 = document.createElement('div');
    t1.className = `item-text${it.audio_error ? ' err' : ''}`;
    t1.innerHTML = `<span class="k">${it.audio_error ? '录音异常' : '识别文字'}</span>`;
    t1.appendChild(document.createTextNode(
      it.audio_error || it.text || '（未识别，点「转文字」）'
    ));
    div.appendChild(t1);

    if (it.translation) {
      const t2 = document.createElement('div');
      t2.className = 'item-text zh';
      t2.innerHTML = `<span class="k">中文翻译</span>`;
      t2.appendChild(document.createTextNode(it.translation));
      div.appendChild(t2);
    }

    const acts = document.createElement('div');
    acts.className = 'item-actions';

    const mk = (label, fn, stop = true) => {
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = label;
      b.onclick = (e) => { if (stop) e.stopPropagation(); fn(); };
      return b;
    };

    acts.appendChild(mk('转文字', () => transcribe(it.id)));
    acts.appendChild(mk('翻译', () => translateItem(it.id)));
    acts.appendChild(mk('复制', () => navigator.clipboard.writeText(it.translation || it.text || '')));
    acts.appendChild(mk('删除', () => removeItem(it.id)));
    div.appendChild(acts);

    box.appendChild(div);
  });
}

// ---------------------------------------------------------------- 初始化

function updateSourceHint() {
  const m = $('source').value;
  const el = $('sourceHint');
  if (m === 'mic') {
    el.textContent = '调用系统麦克风，不弹任何窗口';
  } else if (m === 'system') {
    el.textContent = '由本地服务直接录制声卡回环音，不弹窗口，所有软件的声音都录得到';
  } else {
    el.textContent = '会弹一次浏览器选择框：选「此标签页」并勾选「同时分享标签页音频」';
  }
}

async function init() {
  const cfg = await chrome.storage.local.get(['apiBase', 'solveMode', 'cloudSendHtml']);
  API = cfg.apiBase || DEFAULT_API;
  $('apiBase').value = API;
  $('solveMode').value = cfg.solveMode || 'local';
  $('cloudSendHtml').checked = cfg.cloudSendHtml !== false;
  $('solveMode').onchange = () => {
    chrome.storage.local.set({ solveMode: $('solveMode').value });
    applySolveMode();
  };
  $('cloudSendHtml').onchange = () => chrome.storage.local.set({ cloudSendHtml: $('cloudSendHtml').checked });
  try {
    const cloudConfig = await api('/api/cloud-config');
    $('cloudBaseUrl').value = cloudConfig.base_url || '';
    $('cloudModel').value = cloudConfig.model || '';
    cloudConfigured = !!cloudConfig.configured;
    cloudModelName = cloudConfig.model || '';
    $('cloudApiKey').placeholder = cloudConfigured ? '已保存密钥；留空表示保持不变' : '填写服务商 API Key';
  } catch {
    $('cloudApiKey').placeholder = '启动本地服务后配置';
  }
  applySolveMode();
  updateSourceHint();
  $('source').onchange = updateSourceHint;

  // 网页右侧悬浮球的开关
  const fabCfg = await chrome.storage.local.get(['fabVisible']);
  $('fabVisible').checked = fabCfg.fabVisible !== false;
  $('fabVisible').onchange = async () => {
    const v = $('fabVisible').checked;
    await chrome.storage.local.set({ fabVisible: v });
    setMsg($('setMsg'), v ? '已显示悬浮图标' : '已隐藏悬浮图标，可从工具栏图标或 Ctrl+Shift+Y 打开', 'ok');
  };

  async function showFabPages() {
    const d = await chrome.storage.local.get(['fabPages']);
    const hosts = Object.keys(d.fabPages || {});
    $('fabPages').textContent = hosts.length
      ? `悬浮球已就位：${hosts.slice(0, 4).join('、')}${hosts.length > 4 ? ' 等' + hosts.length + ' 个页面' : ''}`
      : '悬浮球还没在任何网页就位，打开一个网页就会出现在右侧';
  }
  showFabPages();
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === 'local' && 'fabPages' in c) showFabPages();
  });

  $('status').onclick = checkStatus;
  $('btnStart').onclick = () => startRecording();
  $('btnStop').onclick = () => stopRecording(true);
  $('btnTranscribe').onclick = () => transcribe();
  $('btnPageTranslate').onclick = translatePage;
  $('btnPageClear').onclick = clearPage;

  $('btnSolve').onclick = solve;
  $('btnSolveCopy').onclick = () => {
    const b = $('solveAnswer');
    const text = b.hidden ? '' : (b.textContent || '');
    if (!text) { setMsg($('solveMsg'), '还没有解答内容可复制', 'err'); return; }
    navigator.clipboard.writeText(text);
    setMsg($('solveMsg'), '解答已复制', 'ok');
  };

  const grant = async () => {
    const ok = await requestAllSites();
    if (ok) {
      hidePermHint();
      setMsg($('pageMsg'), '已授权全站权限。再点一次「翻译本页英文」即可覆盖 iframe 内容', 'ok');
    }
  };
  $('btnGrant').onclick = grant;
  $('btnGrant2').onclick = grant;

  $('btnRevoke').onclick = async () => {
    // 撤销全站权限后 CSP 规则集必然失效，顺手一起关掉，避免状态不一致
    await chrome.runtime.sendMessage({ target: 'background', type: 'csp-set', on: false });
    await chrome.permissions.remove({ origins: ['<all_urls>', 'file://*/*'] });
    await refreshPerm();
    setMsg($('setMsg'), '已撤销全站权限，现在只能翻译网页主框架', 'ok');
  };

  $('cspBypass').onchange = async (e) => {
    const on = e.target.checked;
    const r = await chrome.runtime.sendMessage({ target: 'background', type: 'csp-set', on });
    if (r && r.error) {
      e.target.checked = !on;
      setMsg($('setMsg'), `切换失败：${r.error}`, 'err');
      return;
    }
    await refreshPerm();
    setMsg($('setMsg'), `已${on ? '开启' : '关闭'} CSP 绕过，刷新网页后生效`, 'ok');
  };

  $('btnSave').onclick = async () => {
    API = ($('apiBase').value || DEFAULT_API).replace(/\/+$/, '');
    await chrome.storage.local.set({ apiBase: API });
    setMsg($('setMsg'), '已保存，正在重新检测…', 'ok');
    await checkStatus();
    await loadHistory();
    render();
  };

  $('btnSaveCloud').onclick = async () => {
    try {
      const result = await api('/api/cloud-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: $('cloudApiKey').value,
          base_url: $('cloudBaseUrl').value.trim(),
          model: $('cloudModel').value.trim()
        })
      });
      $('cloudApiKey').value = '';
      $('cloudApiKey').placeholder = '已保存密钥；留空表示保持不变';
      cloudConfigured = !!result.configured;
      cloudModelName = $('cloudModel').value.trim() || cloudModelName;
      await chrome.storage.local.set({ solveMode: $('solveMode').value });
      applySolveMode();
      setMsg($('setMsg'), result.configured ? '云端配置已保存在本机 data/cloud_config.json' : '配置保存失败', 'ok');
    } catch (e) {
      setMsg($('setMsg'), `云端配置保存失败：${e.message}`, 'err');
    }
  };

  $('btnOpenRecordings').onclick = () => {
    setMsg($('setMsg'), '录音目录：E:\\code\\workbuddy\\tyd插件\\recordings', 'ok');
  };

  await checkStatus();
  await refreshPerm();
  await syncServerRecording();
  await refreshActiveTab();

  // 跟着用户切页实时更新「目标标签页」，事件 + 轮询双保险
  setInterval(refreshActiveTab, 1500);
  try {
    chrome.tabs.onActivated.addListener(refreshActiveTab);
    chrome.tabs.onUpdated.addListener((id) => {
      if (!lockTab && (!activeTab || id === activeTab.id)) refreshActiveTab();
    });
    chrome.tabs.onRemoved.addListener(refreshActiveTab);
  } catch (e) {
    // 拿不到事件也没关系，轮询兜底
  }

  await loadHistory();
  render();
}

init();
