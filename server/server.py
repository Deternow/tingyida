# -*- coding: utf-8 -*-
"""
听译答 浏览器插件 · 本地后端服务

提供四个能力（全部离线，不出本机）：
  1. /api/transcribe   —— 用本地 Vosk 模型把 WAV 音频转成文字（英文 / 中文）
  2. /api/translate    —— 用本地 Argos Translate 模型把英文翻译成中文
  3. /api/history      —— 录制历史（音频路径、识别文字、翻译结果）的增删查
  4. /api/solve        —— 把页面可见文本（含中文）+ 录音文本一并交给本地 Qwen，给出答案并中文解析

启动： python server/server.py
默认监听 http://127.0.0.1:8765
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import wave
from datetime import datetime
from urllib.parse import urlsplit

from flask import Flask, jsonify, request, send_file

# ---------------------------------------------------------------- 路径配置

SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
# 打包成 exe 后 __file__ 指向临时解包目录，项目路径必须改以 exe 所在目录为准
if getattr(sys, "frozen", False):
    BASE_DIR = os.path.dirname(os.path.abspath(sys.executable))
else:
    BASE_DIR = os.path.dirname(SERVER_DIR)
RECORDINGS_DIR = os.path.join(BASE_DIR, "recordings")
DATA_DIR = os.path.join(BASE_DIR, "data")
HISTORY_FILE = os.path.join(DATA_DIR, "history.json")
CLOUD_CONFIG_FILE = os.path.join(DATA_DIR, "cloud_config.json")

if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

for _d in (RECORDINGS_DIR, DATA_DIR):
    os.makedirs(_d, exist_ok=True)

# ---------------------------------------------------------------- 模型位置
# 全部模型都放在工作空间的 models/ 下，整个文件夹拷到别的机器也能直接跑
MODELS_DIR = os.path.join(BASE_DIR, "models")
VOSK_DIR = os.path.join(MODELS_DIR, "vosk")


def _resolve_vosk(name, legacy):
    """优先工作空间内的模型；没有再回退到旧安装位置，方便平滑迁移。

    都不存在时返回「期望路径」而不是 None，这样日志和报错能直接告诉你该放哪儿。
    """
    local = os.path.join(VOSK_DIR, name)
    if os.path.isdir(local):
        return local
    if legacy and os.path.isdir(legacy):
        return legacy
    return local


# Vosk 离线模型目录（缺失的语言会自动跳过）
# 旧版本把模型放在用户主目录的 vosk_models/ 下；这里按当前用户展开，避免写死用户名
_VOSK_LEGACY = os.path.join(os.path.expanduser("~"), "vosk_models")
VOSK_MODEL_DIRS = {
    "en": _resolve_vosk(
        "vosk-model-small-en-us-0.15",
        os.path.join(_VOSK_LEGACY, "vosk-model-small-en-us-0.15"),
    ),
    "zh": _resolve_vosk(
        "vosk-model-small-cn-0.22",
        os.path.join(_VOSK_LEGACY, "vosk-model-small-cn-0.22"),
    ),
}

# 本地大模型（做题用）：Ollama 仓库格式，放在 models/qwen 下，
# 由 qwen.py 负责探测项目 Ollama 端口，必要时带 OLLAMA_MODELS 拉起 ollama serve
QWEN_DIR = os.path.join(MODELS_DIR, "qwen")

HOST = "127.0.0.1"
PORT = 8765

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024
_lock = threading.Lock()

# ---------------------------------------------------------------- 模型缓存

_models = {}          # lang -> vosk.Model
_missing = set()      # 加载失败的语言
_translation = None   # en -> zh 翻译器
_qwen = None          # 本地做题引擎（见 qwen.py）
_qwen_failed_at = 0.0  # 上次拉起失败时刻，避免每次请求都空等一遍启动超时


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


_ascii_model_cache = {}   # lang -> 复制到 ASCII 目录后的模型路径


# Vosk 模型的最小完整性探针。只检查目录/标记文件不够：Windows 的磁盘清理
# 可能保留顶层小文件，却删掉 TEMP 里的大模型子目录（2026-10-26 实际发生过）。
_VOSK_ANCHORS = (
    os.path.join("am", "final.mdl"),
    os.path.join("conf", "model.conf"),
    os.path.join("graph", "HCLr.fst"),
)


def _valid_vosk_model(path):
    """目录是否至少包含 Vosk 加载必需的关键文件，且文件不是空壳"""
    if not path or not os.path.isdir(path):
        return False
    try:
        return all(
            os.path.isfile(os.path.join(path, rel))
            and os.path.getsize(os.path.join(path, rel)) > 0
            for rel in _VOSK_ANCHORS
        )
    except OSError:
        return False


def _ascii_model_path(lang, src):
    """把模型复制到纯 ASCII 目录，返回新路径。

    为什么需要：Vosk 底层是 Kaldi C++，用本地代码页（GBK）打开路径。
    当路径里有中文（比如本项目位于 `E:\\code\\workbuddy\\tyd插件\\...`）时，
    它会把 UTF-8 编码的中文字节流按 GBK 解析，结果找不到文件，
    报一句具有误导性的 `Folder ... does not contain model files` ——
    文件明明就在那儿。

    实测：同样的模型放到 ASCII 路径下能正常加载；中文路径必失败；
    `GetShortPathName` 取 8.3 短名在部分磁盘上被禁用，指望不上；
    `mklink /J` 建 junction 需要管理员权限，也不是通用解。

    所以采用「复制到 ASCII 临时目录」。模型本身仍以工作空间的 `models\\`
    为唯一真源。副本每次使用前都检查关键文件：TEMP 可能被磁盘清理工具部分清空，
    不能只信 `.tyd_copy_ok` 标记。
    """
    cached = _ascii_model_cache.get(lang)
    if cached and _valid_vosk_model(cached):
        return cached
    # 缓存指向的副本被系统清理了，忘掉它，下面会自动重建
    _ascii_model_cache.pop(lang, None)

    # 路径本来就是 ASCII，直接用，不必折腾
    if all(ord(c) < 128 for c in src):
        _ascii_model_cache[lang] = src
        return src

    dst = os.path.join(tempfile.gettempdir(), "tyd_models", f"{lang}-{os.path.basename(src)}")
    marker = os.path.join(dst, ".tyd_copy_ok")

    # 标记文件存在但关键文件缺失时，视为坏副本，整目录重建
    if not os.path.exists(marker) or not _valid_vosk_model(dst):
        if os.path.isdir(dst):
            shutil.rmtree(dst, ignore_errors=True)
        log(f"模型路径含中文，Vosk 读不了，正在复制到 ASCII 目录：{dst}")
        log("（首次复制约几秒，之后复用；这期间请稍候）")
        try:
            shutil.copytree(src, dst)
            if not _valid_vosk_model(dst):
                raise RuntimeError("复制结束但模型关键文件不完整")
            with open(marker, "w", encoding="ascii") as f:
                f.write("ok")
            log("复制完成，完整性检查通过")
        except Exception as e:  # noqa: BLE001
            log(f"复制模型失败，仍尝试用原路径：{e}")
            _ascii_model_cache[lang] = src
            return src

    _ascii_model_cache[lang] = dst
    return dst


def load_model(lang):
    """懒加载并缓存 Vosk 模型，失败只报一次"""
    if lang in _models:
        return _models[lang]
    if lang in _missing:
        return None
    path = VOSK_MODEL_DIRS.get(lang)
    if not _valid_vosk_model(path):
        _missing.add(lang)
        log(f"模型缺失或不完整: {lang} -> {path}")
        return None
    # 含中文的路径必须换成 ASCII 副本，否则 Vosk 直接加载失败
    path = _ascii_model_path(lang, path)
    try:
        from vosk import Model, SetLogLevel

        SetLogLevel(-1)
        t0 = time.time()
        _models[lang] = Model(path)
        log(f"已加载 {lang} 模型 {path} ({time.time() - t0:.1f}s)")
        return _models[lang]
    except Exception as e:  # noqa: BLE001
        _missing.add(lang)
        log(f"加载 {lang} 模型失败: {e}")
        return None


def _translation_ready():
    """翻译模型文件是否已在本地就位（不实际加载）"""
    try:
        import translator as t

        return os.path.isdir(t.MODEL_DIR) and os.path.exists(t.SP_MODEL)
    except Exception:  # noqa: BLE001
        return False


def get_translator():
    """懒加载离线翻译引擎（CTranslate2，见 translator.py）"""
    global _translation
    if _translation is not None:
        return _translation
    try:
        import translator as translator_mod
    except Exception as e:  # noqa: BLE001
        log(f"翻译模块不可用: {e}")
        return None

    try:
        engine = translator_mod.get_engine()
    except Exception as e:  # noqa: BLE001
        log(f"加载翻译模型失败: {e}")
        return None

    if engine is None:
        log("翻译模型未就绪，请运行 server/install_translation_model.py")
        return None
    _translation = engine
    return _translation


def _qwen_status():
    """本地做题能力：模型文件 + Ollama 是否都在（不拉起 Ollama，避免拖慢状态检查）"""
    try:
        import qwen as qwen_mod

        return qwen_mod.local_model_status()
    except Exception as e:  # noqa: BLE001
        return {"available": False, "model": None, "reason": f"检测失败：{e}"}


def get_qwen():
    """懒加载本地做题引擎；模型或服务不可用时返回 None"""
    global _qwen, _qwen_failed_at
    if _qwen is not None:
        return _qwen
    now = time.time()
    # 刚失败过就别再空等一轮启动超时，一分钟后才重试
    if _qwen_failed_at and now - _qwen_failed_at < 60:
        return None
    try:
        import qwen as qwen_mod
    except Exception as e:  # noqa: BLE001
        log(f"做题模块不可用: {e}")
        _qwen_failed_at = now
        return None

    _qwen = qwen_mod.get_engine()
    if _qwen is None:
        _qwen_failed_at = now
        log(f"做题引擎未就绪: {qwen_mod.engine_error()}")
    return _qwen


# ---------------------------------------------------------------- 音频处理


def ensure_wav16k(src_path):
    """确保是 16kHz / 单声道 / 16bit PCM；不是则用 ffmpeg 转换"""
    try:
        wf = wave.open(src_path, "rb")
        ok = (
            wf.getnchannels() == 1
            and wf.getsampwidth() == 2
            and wf.getframerate() == 16000
        )
        wf.close()
        if ok:
            return src_path
    except Exception:  # noqa: BLE001
        pass

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("音频格式不是 16k 单声道 WAV，且未找到 ffmpeg 无法转换")

    dst = src_path + ".conv.wav"
    cmd = [
        ffmpeg, "-y", "-i", src_path,
        "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", dst,
    ]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    return dst


def _score(all_results):
    """汇总一次识别的所有结果段，返回 (conf, valid_words, unk_ratio)。

    必须跨段汇总，不能取"置信度最高的那段"——短段容易出假高分：
    英语音频喂中文模型时，`这 是 [unk]` 这种 3 词段 conf 高达 0.98，
    按段取 max 会把英文误判成中文。汇总后假高分被长段稀释，暴露原型。
    """
    valid_confs, unk_n, total = [], 0, 0
    for r in all_results:
        for w in (r.get("result") or []):
            if not w.get("word"):
                continue
            total += 1
            if w["word"] == "[unk]":
                unk_n += 1
            else:
                valid_confs.append(w.get("conf", 0.0))
    valid = len(valid_confs)
    unk_ratio = (unk_n / total) if total else 1.0
    conf = (sum(valid_confs) / valid) if valid else 0.0
    return conf, valid, unk_ratio


def run_vosk(path, lang):
    """对单个语言跑一次识别，返回 (text, conf, valid_words, unk_ratio)"""
    model = load_model(lang)
    if model is None:
        return "", 0.0, 0, 1.0
    from vosk import KaldiRecognizer

    wf = wave.open(path, "rb")
    rec = KaldiRecognizer(model, wf.getframerate())
    rec.SetWords(True)

    finals = []
    while True:
        data = wf.readframes(4000)
        if len(data) == 0:
            break
        if rec.AcceptWaveform(data):
            finals.append(json.loads(rec.Result()))
    finals.append(json.loads(rec.FinalResult()))
    wf.close()

    text = " ".join((r.get("text") or "").strip() for r in finals).strip()
    text = re.sub(r"\s+", " ", text)
    conf, valid, unk = _score(finals)
    return text, conf, valid, unk


def transcribe(path, lang="auto"):
    """lang: en / zh / auto。

    面板（v1.8.3 起）只暴露 en / zh 手动选择，「自动」因错误率较高已从
    UI 移除；此分支保留给直接调 API 的场景和旧版面板兜底。
    auto 不能只比置信度——英语音频喂中文模型会出假高分。这里对每个
    模型汇总三个指标，按三票多数裁定：
      1. 有效词数（模型真正听懂了多少，[unk] 不计）
      2. 词级置信度（跨段汇总后的平均值）
      3. [unk] 占比（模型在"硬猜"的比例）
    全票型平局（通常是两个模型都全军覆没）默认按英文走后续翻译链路。
    """
    path = ensure_wav16k(path)
    if lang in ("en", "zh"):
        text = run_vosk(path, lang)[0]
        return text, lang

    cands = {}
    for cand in ("en", "zh"):
        text, conf, valid, unk = run_vosk(path, cand)
        cands[cand] = (text, conf, valid, unk)
        log(f"  auto[{cand}] conf={conf:.3f} words={valid} unk={unk:.2f} text={text[:60]!r}")

    en_c, zh_c = cands["en"], cands["zh"]
    if en_c[2] == 0 and zh_c[2] == 0:
        return "", "en"
    votes_en = (
        (1 if en_c[2] > zh_c[2] else 0)    # 有效词数更多
        + (1 if en_c[1] > zh_c[1] else 0)  # 置信度更高
        + (1 if en_c[3] < zh_c[3] else 0)  # [unk] 占比更低
    )
    return (en_c[0], "en") if votes_en >= 2 else (zh_c[0], "zh")


# ---------------------------------------------------------------- 历史记录


def read_history():
    if not os.path.exists(HISTORY_FILE):
        return {"items": []}
    try:
        with open(HISTORY_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and "items" in data:
            return data
    except Exception as e:  # noqa: BLE001
        log(f"历史文件解析失败，已重置: {e}")
    return {"items": []}


def write_history(data):
    tmp = HISTORY_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, HISTORY_FILE)


def find_item(item_id):
    data = read_history()
    for it in data["items"]:
        if it["id"] == item_id:
            return data, it
    return data, None


# ---------------------------------------------------------------- HTTP 接口


@app.after_request
def add_cors(resp):
    origin = request.headers.get("Origin", "")
    if origin == "null" or origin.startswith(("chrome-extension://", "http://127.0.0.1", "http://localhost")):
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,DELETE,OPTIONS"
    return resp


@app.route("/api/status", methods=["GET", "OPTIONS"])
def status():
    if request.method == "OPTIONS":
        return ("", 204)
    qwen_status = _qwen_status()
    cloud_cfg = read_cloud_config()
    return jsonify({
        "ok": True,
        "asr_models": {k: os.path.isdir(v) for k, v in VOSK_MODEL_DIRS.items()},
        "asr_loaded": sorted(_models.keys()),
        "translation_installed": _translation is not None or _translation_ready(),
        "qwen": {
            "installed": qwen_status["available"],
            "model": qwen_status["model"],
            "reason": qwen_status["reason"],
        },
        "cloud": {
            "configured": bool(cloud_cfg.get("api_key")),
            "model": cloud_cfg.get("model", ""),
        },
    })


@app.route("/api/transcribe", methods=["POST", "OPTIONS"])
def api_transcribe():
    if request.method == "OPTIONS":
        return ("", 204)

    lang = request.form.get("lang", "auto") or "auto"
    duration = float(request.form.get("duration", 0) or 0)

    # 已有条目 -> 重新识别；否则新建条目并保存音频
    item_id = request.form.get("id")
    file = request.files.get("file")

    if item_id:
        data, item = find_item(item_id)
        if item is None:
            return jsonify({"error": "条目不存在"}), 404
        if file:
            filename = os.path.basename(item["audio"])
            file.save(os.path.join(RECORDINGS_DIR, filename))
        wav_path = os.path.join(RECORDINGS_DIR, os.path.basename(item["audio"]))
    else:
        if not file:
            return jsonify({"error": "缺少音频文件"}), 400
        item_id = uuid.uuid4().hex[:12]
        filename = f"rec_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{item_id}.wav"
        wav_path = os.path.join(RECORDINGS_DIR, filename)
        file.save(wav_path)
        item = {
            "id": item_id,
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "audio": filename,
            "duration": round(duration, 2),
            "text": "",
            "lang": "",
            "translation": "",
        }
        data = read_history()
        data["items"].insert(0, item)

    if not os.path.exists(wav_path):
        return jsonify({"error": "音频文件不存在"}), 400

    # 先落盘，保证音频和条目不会丢
    with _lock:
        data = read_history()
        exists = False
        for i, it in enumerate(data["items"]):
            if it["id"] == item_id:
                data["items"][i] = item
                exists = True
                break
        if not exists:
            data["items"].insert(0, item)
        write_history(data)

    # transcribe=0：只保存音频，不识别（用户稍后点「转成文字」）
    if request.form.get("transcribe", "1") == "0":
        log(f"已保存音频 id={item_id}（未识别）")
        return jsonify({"ok": True, "item": item})

    t0 = time.time()
    try:
        text, detected = transcribe(wav_path, lang)
    except Exception as e:  # noqa: BLE001
        log(f"识别失败: {e}")
        return jsonify({"error": f"识别失败: {e}"}), 500

    item["text"] = text
    item["lang"] = detected
    item["duration"] = round(duration or item.get("duration", 0), 2)
    item["transcribed_at"] = datetime.now().isoformat(timespec="seconds")
    item["cost"] = round(time.time() - t0, 2)

    with _lock:
        data = read_history()
        exists = False
        for i, it in enumerate(data["items"]):
            if it["id"] == item_id:
                data["items"][i] = item
                exists = True
                break
        if not exists:
            data["items"].insert(0, item)
        write_history(data)

    log(f"识别完成 id={item_id} lang={detected} cost={item['cost']}s text={text[:60]!r}")
    return jsonify({"ok": True, "item": item})


@app.route("/api/translate", methods=["POST", "OPTIONS"])
def api_translate():
    """批量翻译：{texts: [...]} -> {translations: [...]}"""
    if request.method == "OPTIONS":
        return ("", 204)
    payload = request.get_json(force=True, silent=True) or {}
    texts = payload.get("texts") or []
    if not texts:
        return jsonify({"translations": []})

    tr = get_translator()
    if tr is None:
        return jsonify({"error": "翻译模型未安装，请运行 server/install_translation_model.py"}), 503

    out = []
    for t in texts:
        t = (t or "").strip()
        if not t or not re.search(r"[A-Za-z]", t):
            out.append(t)
            continue
        try:
            out.append(tr.translate(t))
        except Exception as e:  # noqa: BLE001
            log(f"翻译失败: {e}")
            out.append("")
    return jsonify({"translations": out})


@app.route("/api/solve", methods=["POST", "OPTIONS"])
def api_solve():
    """做题：{page, transcript, question} -> {answer, cost}

    page 是网页上的可见文本（由各框架 content.js 收集汇总，英文/中文都收），
    transcript 是录音识别出的文本（提交识别文本，不直接上传音频给 Qwen）。
    两者一并交给本地 Qwen，系统提示词规定用中文作答（见 qwen.py）。
    """
    if request.method == "OPTIONS":
        return ("", 204)
    payload = request.get_json(force=True, silent=True) or {}
    page = (payload.get("page") or "").strip()
    transcript = (payload.get("transcript") or "").strip()
    question = (payload.get("question") or "").strip()

    if not page and not transcript:
        return jsonify({"error": "没有可作答的内容：先翻译一下网页，或录一段音频"}), 400

    eng = get_qwen()
    if eng is None:
        hint = "本地做题模型不可用"
        try:
            import qwen as qwen_mod

            hint = f"本地做题模型不可用：{qwen_mod.engine_error() or '未知原因'}"
        except Exception:  # noqa: BLE001
            pass
        return jsonify({"error": hint}), 503

    fitted_page, fitted_transcript, fitted_question, truncated = eng.fit_input(
        page, transcript, question
    )
    input_info = {
        "page_chars": len(fitted_page),
        "transcript_chars": len(fitted_transcript),
        "question_chars": len(fitted_question),
        "total_chars": len(fitted_page) + len(fitted_transcript) + len(fitted_question),
        "original_chars": len(page) + len(transcript) + len(question),
        "truncated": truncated,
    }

    t0 = time.time()
    try:
        answer = eng.solve(fitted_page, fitted_transcript, fitted_question)
    except Exception as e:  # noqa: BLE001
        log(f"做题失败: {e}")
        return jsonify({"error": f"做题失败：{e}"}), 500

    cost = round(time.time() - t0, 2)
    log(
        f"做题完成 cost={cost}s input={input_info['total_chars']}字 "
        f"original={input_info['original_chars']}字 truncated={truncated}"
    )
    return jsonify({"ok": True, "answer": answer, "cost": cost, "input": input_info})


def read_cloud_config():
    try:
        with open(CLOUD_CONFIG_FILE, "r", encoding="utf-8") as f:
            config = json.load(f)
        return config if isinstance(config, dict) else {}
    except (OSError, ValueError):
        return {}


def write_cloud_config(config):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = CLOUD_CONFIG_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CLOUD_CONFIG_FILE)
    try:
        os.chmod(CLOUD_CONFIG_FILE, 0o600)
    except OSError:
        pass


@app.route("/api/cloud-config", methods=["GET", "POST", "OPTIONS"])
def api_cloud_config():
    if request.method == "OPTIONS":
        return ("", 204)
    if request.method == "GET":
        config = read_cloud_config()
        return jsonify({
            "configured": bool(config.get("api_key")),
            "base_url": config.get("base_url", ""),
            "model": config.get("model", ""),
        })

    payload = request.get_json(force=True, silent=True) or {}
    current = read_cloud_config()
    api_key = (payload.get("api_key") or "").strip() or current.get("api_key", "")
    base_url = (payload.get("base_url") or "").strip().rstrip("/") or current.get("base_url", "")
    model = (payload.get("model") or "").strip() or current.get("model", "")
    if not api_key:
        return jsonify({"error": "请填写 API Key"}), 400
    parsed_url = urlsplit(base_url)
    if (
        parsed_url.scheme not in ("https", "http")
        or not parsed_url.hostname
        or parsed_url.username
        or parsed_url.password
        or len(base_url) > 500
    ):
        return jsonify({"error": "接口地址必须是有效的 HTTP(S) 地址，且不能包含账号密码"}), 400
    if not model or len(model) > 200:
        return jsonify({"error": "请填写有效的模型名称"}), 400
    write_cloud_config({"api_key": api_key, "base_url": base_url, "model": model})
    return jsonify({"ok": True, "configured": True})


@app.route("/api/cloud-solve", methods=["POST", "OPTIONS"])
def api_cloud_solve():
    if request.method == "OPTIONS":
        return ("", 204)
    if request.content_length and request.content_length > 50 * 1024 * 1024:
        return jsonify({"error": "请求过大（上限 50 MB）"}), 413
    payload = request.get_json(force=True, silent=True) or {}
    page = str(payload.get("page") or "")
    transcript = str(payload.get("transcript") or "")
    question = str(payload.get("question") or "")
    html = str(payload.get("html") or "")
    if len(html) > 2_000_000:
        return jsonify({"error": "页面 HTML 超过 2,000,000 字符上限"}), 413
    if len(page) + len(transcript) + len(question) > 100_000:
        return jsonify({"error": "页面文本与补充说明超过 100,000 字符上限"}), 413
    if not page and not transcript and not html:
        return jsonify({"error": "没有可作答的内容"}), 400

    config = read_cloud_config()
    if not config.get("api_key"):
        return jsonify({"error": "尚未配置云端 API Key"}), 400

    try:
        import qwen as qwen_mod
        solver = qwen_mod.CloudSolver(
            config["base_url"], config["api_key"], config["model"]
        )
        t0 = time.time()
        answer, truncated = solver.solve(page, transcript, question, html=html)
    except Exception as e:  # noqa: BLE001
        log(f"云端做题失败: {type(e).__name__}")
        return jsonify({"error": "云端调用失败，请检查接口地址、模型支持情况和网络连接"}), 502

    return jsonify({
        "ok": True,
        "answer": answer,
        "cost": round(time.time() - t0, 2),
        "input": {
            "page_chars": len(page),
            "transcript_chars": len(transcript),
            "html_chars": len(html),
            "truncated": truncated,
        },
    })


@app.route("/api/history", methods=["GET", "OPTIONS"])
def api_history():

    if request.method == "OPTIONS":
        return ("", 204)
    return jsonify(read_history())


@app.route("/api/history/translate", methods=["POST", "OPTIONS"])
def api_history_translate():
    """把某条识别结果翻译成中文并写回历史"""
    if request.method == "OPTIONS":
        return ("", 204)
    payload = request.get_json(force=True, silent=True) or {}
    item_id = payload.get("id")
    data, item = find_item(item_id)
    if item is None:
        return jsonify({"error": "条目不存在"}), 404
    if not item.get("text"):
        return jsonify({"error": "该条目还没有识别文字"}), 400
    if item.get("lang") == "zh" or not re.search(r"[A-Za-z]", item["text"]):
        # 翻译成中文会把中文塞进英译中模型，结果是一串无意义的符号
        return jsonify({"error": "识别结果是中文，无需翻译"}), 400

    tr = get_translator()
    if tr is None:
        return jsonify({"error": "翻译模型未安装"}), 503

    t0 = time.time()
    try:
        zh = tr.translate(item["text"])
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": f"翻译失败: {e}"}), 500

    item["translation"] = zh
    item["translated_at"] = datetime.now().isoformat(timespec="seconds")
    with _lock:
        data = read_history()
        for i, it in enumerate(data["items"]):
            if it["id"] == item_id:
                data["items"][i] = item
                break
        write_history(data)
    log(f"翻译完成 id={item_id} cost={time.time() - t0:.2f}s")
    return jsonify({"ok": True, "item": item})


@app.route("/api/history/delete", methods=["POST", "OPTIONS"])
def api_history_delete():
    if request.method == "OPTIONS":
        return ("", 204)
    payload = request.get_json(force=True, silent=True) or {}
    item_id = payload.get("id")
    with _lock:
        data = read_history()
        before = len(data["items"])
        target = next((i for i in data["items"] if i["id"] == item_id), None)
        data["items"] = [i for i in data["items"] if i["id"] != item_id]
        if target:
            p = os.path.join(RECORDINGS_DIR, os.path.basename(target["audio"]))
            if os.path.exists(p):
                try:
                    os.remove(p)
                except OSError:
                    pass
        write_history(data)
    return jsonify({"ok": True, "removed": before - len(data["items"])})


# ------------------------------------------------------- 系统音频录制（免弹窗）

_sys_state = {
    "recording": False,
    "stop": None,
    "frames": [],
    "t0": 0.0,
    "error": None,
    "level": 0.0,
    "thread": None,
    "token": 0,          # 每次 start 递增，用于判定采集线程是否已被取代
}


def _import_soundcard():
    try:
        import soundcard  # noqa: F401
        return soundcard
    except Exception:  # noqa: BLE001
        return None


def _sys_capture_worker():
    """后台采集 Windows 回环音频（扬声器正在播放的一切）"""
    sc = _import_soundcard()
    if sc is None:
        _sys_state["error"] = "soundcard 未安装"
        _sys_state["recording"] = False
        return

    # 记住自己属于哪一次录制。若期间用户又开了一次（token 变了），
    # 本线程必须立刻让位：既不能继续往 frames 里塞数据，也不能去清标志位。
    my_token = _sys_state.get("token", 0)

    # soundcard 底层是 WASAPI/COM，子线程里必须自己初始化，否则报 Error 0x800401f0
    import ctypes
    try:
        ctypes.windll.ole32.CoInitializeEx(None, 0x0)  # COINIT_MULTITHREADED
    except Exception:  # noqa: BLE001
        pass

    import numpy as np

    try:
        speaker = sc.default_speaker()
        loopback = sc.get_microphone(id=str(speaker.name), include_loopback=True)
        log(f"系统录制设备: {loopback.name}")
        _sys_state["frames"] = []
        with loopback.recorder(samplerate=16000, channels=1, blocksize=2048) as rec:
            while not _sys_state["stop"].is_set():
                block = rec.record(numframes=2048)
                # 本次录制已被新一轮取代，立即退出，别污染新录制的音频
                if _sys_state.get("token") != my_token:
                    log("采集线程检测到录制已被取代，退出")
                    return
                arr = np.asarray(block, dtype="float32").reshape(-1)
                _sys_state["frames"].append(arr)
                _sys_state["level"] = float(np.sqrt(float((arr ** 2).mean())))
    except Exception as e:  # noqa: BLE001
        _sys_state["error"] = str(e)
        log(f"系统录制异常: {e}")
    finally:
        try:
            ctypes.windll.ole32.CoUninitialize()
        except Exception:  # noqa: BLE001
            pass
        # 只有仍属于本次录制时才清标志位。
        # 旧线程若延迟退出，无条件清会把新录制的状态误清成「没在录」。
        if _sys_state.get("token") == my_token:
            _sys_state["recording"] = False


@app.route("/api/system-record/start", methods=["POST", "OPTIONS"])
def api_sys_start():
    if request.method == "OPTIONS":
        return ("", 204)
    if _sys_state["recording"]:
        return jsonify({"error": "已经在录制了"}), 400
    if _import_soundcard() is None:
        return jsonify({"error": "缺少 soundcard 库，请运行 pip install soundcard"}), 503

    _sys_state.update({
        "recording": True,
        "stop": threading.Event(),
        "frames": [],
        "t0": time.time(),
        "error": None,
        "level": 0.0,
        "token": _sys_state.get("token", 0) + 1,
    })
    t = threading.Thread(target=_sys_capture_worker, daemon=True)
    _sys_state["thread"] = t
    t.start()
    log("系统音频录制开始")
    return jsonify({"ok": True})


@app.route("/api/system-record/stop", methods=["POST", "OPTIONS"])
def api_sys_stop():
    if request.method == "OPTIONS":
        return ("", 204)
    if not _sys_state["recording"]:
        return jsonify({"error": "当前没有在录制"}), 400

    payload = request.get_json(force=True, silent=True) or {}
    lang = payload.get("lang", "auto") or "auto"
    do_transcribe = str(payload.get("transcribe", "1")) != "0"

    _sys_state["stop"].set()
    th = _sys_state.get("thread")
    if th:
        th.join(timeout=6)
    _sys_state["recording"] = False

    if _sys_state.get("error"):
        return jsonify({"error": _sys_state["error"]}), 500

    frames = _sys_state.get("frames") or []
    if not frames:
        return jsonify({"error": "没有采集到音频"}), 500

    import numpy as np

    pcm = np.concatenate(frames).astype("float32")
    duration = round(time.time() - _sys_state["t0"], 2)

    item_id = uuid.uuid4().hex[:12]
    filename = f"rec_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{item_id}.wav"
    wav_path = os.path.join(RECORDINGS_DIR, filename)

    # 声音有效性检测：系统回环即使没声音也会持续返回极低幅噪声，
    # 不能只看 frames 是否为空。实测正常播放 RMS 约 0.07，而本次故障样本
    # 只有 0.0003~0.0005。低于门限仍保存 WAV，方便排查，但明确标为静音。
    rms = float(np.sqrt(float((pcm ** 2).mean()))) if pcm.size else 0.0
    peak = float(np.max(np.abs(pcm))) if pcm.size else 0.0
    silent = rms < 0.001 and peak < 0.01

    data16 = np.clip(pcm, -1.0, 1.0)
    data16 = (data16 * 32767).astype("<i2")
    with wave.open(wav_path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(data16.tobytes())

    item = {
        "id": item_id,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "audio": filename,
        "duration": duration,
        "source": "system",
        "text": "",
        "lang": "",
        "translation": "",
    }
    with _lock:
        data = read_history()
        data["items"].insert(0, item)
        write_history(data)

    log(
        f"系统录制保存 {filename} ({duration}s, {len(pcm)} 采样, "
        f"rms={rms:.5f}, peak={peak:.5f})"
    )

    if silent:
        # 保存历史和音频，但不让 Vosk 对近乎静音的数据硬猜；
        # 前端据此给出明确提示，而不是笼统显示「没有听清」。
        item["audio_error"] = "录音几乎没有声音，请确认电脑正在播放音频且音量未静音"
        item["lang"] = lang if lang in ("en", "zh") else ""
        item["transcribed_at"] = datetime.now().isoformat(timespec="seconds")
        item["cost"] = 0.0
        with _lock:
            data = read_history()
            for i, it in enumerate(data["items"]):
                if it["id"] == item_id:
                    data["items"][i] = item
                    break
            write_history(data)
        log(f"系统录制音量过低，跳过识别 id={item_id}")
        return jsonify({"ok": True, "item": item, "warning": item["audio_error"]})

    if not do_transcribe:
        return jsonify({"ok": True, "item": item})

    t0 = time.time()
    try:
        text, detected = transcribe(wav_path, lang)
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": f"识别失败: {e}"}), 500

    item["text"] = text
    item["lang"] = detected
    item["transcribed_at"] = datetime.now().isoformat(timespec="seconds")
    item["cost"] = round(time.time() - t0, 2)
    with _lock:
        data = read_history()
        for i, it in enumerate(data["items"]):
            if it["id"] == item_id:
                data["items"][i] = item
                break
        write_history(data)

    log(f"系统录制识别完成 id={item_id} lang={detected} text={text[:60]!r}")
    return jsonify({"ok": True, "item": item})


@app.route("/api/system-record/status", methods=["GET", "OPTIONS"])
def api_sys_status():
    if request.method == "OPTIONS":
        return ("", 204)
    return jsonify({
        "recording": bool(_sys_state["recording"]),
        "elapsed": round(time.time() - _sys_state["t0"], 1) if _sys_state["recording"] else 0,
        "level": round(float(_sys_state.get("level") or 0), 4),
        "error": _sys_state.get("error"),
        "available": _import_soundcard() is not None,
    })


@app.route("/api/audio/<path:filename>", methods=["GET"])
def api_audio(filename):
    p = os.path.join(RECORDINGS_DIR, os.path.basename(filename))
    if not os.path.exists(p):
        return jsonify({"error": "not found"}), 404
    return send_file(p, mimetype="audio/wav")


@app.route("/", methods=["GET"])
def index():
    return jsonify({"name": "tyd-extension-server", "ok": True})


def main():
    log(f"服务启动 http://{HOST}:{PORT}")
    log(f"录音目录: {RECORDINGS_DIR}")
    log(f"历史文件: {HISTORY_FILE}")
    for lang, path in VOSK_MODEL_DIRS.items():
        log(f"ASR 模型 {lang}: {'就绪' if os.path.isdir(path) else '缺失'} ({path})")
    app.run(host=HOST, port=PORT, threaded=True)


if __name__ == "__main__":
    main()
