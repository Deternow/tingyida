# -*- coding: utf-8 -*-
"""
本地 Qwen 做题引擎：把「页面可见文本（含中文）+ 录音识别文本」一起交给本地
Ollama 里跑的 Qwen 模型，让它给出答案并用中文解析。

为什么走 Ollama
---------------
`models/qwen` 是 Ollama 的模型仓库格式（blobs / manifests / metadata），
交给 Ollama 起 llama.cpp 来加载，显存调度、KV cache、量化格式都由它负责，
比自己引 transformers / ctranslate2 省事得多，也符合项目「全程离线、不出
本机」的定位——Ollama 仅监听本机回环地址（默认使用项目端口 11435）。

运行模式说明
------------
1. 为避免思维链占满生成预算，本模块显式设置 `"think": false`，只请求最终答案。
   Ollama 的 `message.thinking` 不会启用，也不会展示给用户。
2. 关闭 thinking 后响应更快，普通题优先在较小的生成预算内直接输出三段式答案；
   请求超时仍保留 360 秒，避免首次加载 9B 模型时过早失败。
3. 输出语言继续由 system 和 user 两处共同约束为简体中文，避免模型跟随英文题目
   使用英文作答。

另外：系统代理会把 127.0.0.1 的请求劫走（表现为 502 Bad Gateway），所以这里
的 urllib 全部用 `ProxyHandler({})` 强制直连。
"""

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

_SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
# 冻结成 exe 后以 exe 所在目录当作项目根目录（模型仍放在 exe 旁边的 models/）
BASE_DIR = (
    os.path.dirname(os.path.abspath(sys.executable))
    if getattr(sys, "frozen", False)
    else os.path.dirname(_SERVER_DIR)
)
MODELS_DIR = os.path.join(BASE_DIR, "models", "qwen")

_OLLAMA_HOST_SETTING = os.environ.get("OLLAMA_HOST", "127.0.0.1:11435").rstrip("/")
OLLAMA_HOST = (
    _OLLAMA_HOST_SETTING
    if _OLLAMA_HOST_SETTING.startswith(("http://", "https://"))
    else f"http://{_OLLAMA_HOST_SETTING}"
)
OLLAMA_BIND = OLLAMA_HOST.removeprefix("http://").removeprefix("https://")
DEFAULT_MODEL = "qwen3.5:9b"
# 模型理论支持 262K，但这台机器 8GB 显存实际运行应控制 KV cache。
# 8192 tokens 是长题目完整度、速度和显存占用之间的稳妥平衡。
NUM_CTX = 8192
# 普通模式只生成最终答案；恢复原先的轻量输出预算，避免无谓等待。
NUM_PREDICT = 1024
# 关闭 thinking 后不需要为思维链预留空间。
# 这里的单位是「上下文单位」而不是字符：拉丁字符 1 字 1 单位，中日韩字符 1 字 4 单位
# （约等于 4 个单位 1 个 token）。28000 单位 ≈ 7000 token，英文仍是原来的 28000 字符。
MAX_INPUT_CHARS = 28000


def _units(text):
    """把文本折算成上下文单位，避免中文题目把本地 8192 token 挤爆"""
    if not text:
        return 0
    cjk = sum(
        1
        for ch in text
        if "\u3400" <= ch <= "\u9fff" or "\uf900" <= ch <= "\ufaff"
    )
    return cjk * 4 + (len(text) - cjk)

# Ollama 不同版本把 manifest 放的位置不一样，两个都扫一遍
_MANIFEST_ROOTS = [
    os.path.join("manifests", "registry.ollama.ai", "library"),
    os.path.join("manifests-v2", "ollama.com", "library"),
]

SYSTEM_PROMPT = """你是中文做题助手，只做一件事：根据给出的题目文本，给出正确答案并用中文讲解。

输入说明：
- 【页面原文】：题目所在网页上的可见文本（题干、选项、上下文），可能是英文，也可能是中文。
- 【语音文本】：录音识别得到的文本（可能是题目要求、补充说明或朗读的题干），可能是英文或中文。
- 两部分是同一道题的素材；若两者冲突，以页面原文为准。

输出要求（严格遵守）：
1. 全程使用简体中文。除专有名词、代码、必要的英文术语外，不要写出完整的英文句子。
2. 严格按下面顺序输出，标题原样照抄；先完整解答，最后再总结答案：
【解析】先结合题意逐步说明解题依据，必要时翻译关键英文，讲清判断过程及其他选项为什么不合适。
【要点】列出本题涉及的知识点或易错点（没有可省略）。
【答案总结】最后用简体中文的一句话给出最终选项或结论；若答案本身是英文词，应附上中文释义（如「B：办公室（Office）」或「巴黎（Paris）」）。不得在前文提前揭晓最终答案。
3. 不要复述题目全文，不要输出「好的」「以下是」这类客套话，不要使用 Markdown 标题语法。"""

USER_TEMPLATE = """【页面原文】
{page}

【语音文本】
{transcript}
{question}
请用中文，先输出「【解析】」，再输出「【要点】」，最后用「【答案总结】」给出最终答案；不要在前文提前揭晓结论。"""


def _log(msg):
    print(f"[qwen:{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def detect_model_name():
    """从 models/qwen/manifests 目录结构推断模型名，如 qwen3.5:9b"""
    for rel in _MANIFEST_ROOTS:
        root = os.path.join(MODELS_DIR, rel)
        if not os.path.isdir(root):
            continue
        for name in sorted(os.listdir(root)):
            d = os.path.join(root, name)
            if not os.path.isdir(d):
                continue
            for tag in sorted(os.listdir(d)):
                if os.path.isfile(os.path.join(d, tag)):
                    return f"{name}:{tag}"
    return None


def local_model_status():
    """本机是否具备本地作答能力（只看文件与 Ollama 是否存在，不拉起服务）。

    返回 {available, model, reason}；available=False 时前端应只允许云端 API。
    """
    model = detect_model_name()
    if not model:
        if not os.path.isdir(MODELS_DIR):
            return {
                "available": False,
                "model": None,
                "reason": "缺少 models/qwen 目录，尚未安装本地模型",
            }
        return {
            "available": False,
            "model": None,
            "reason": "models/qwen 里没有模型文件，下载可能未完成",
        }
    if not _find_ollama_exe():
        return {
            "available": False,
            "model": model,
            "reason": "模型文件在，但没检测到 Ollama，无法加载",
        }
    return {"available": True, "model": model, "reason": ""}


def _request(path, payload=None, timeout=10, method=None):
    """对 Ollama 发 JSON 请求；强制直连，绕过系统代理"""
    url = f"{OLLAMA_HOST}{path}"
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        url, data=data, headers=headers, method=method or ("POST" if data else "GET")
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def probe(timeout=5):
    """Ollama 是否在跑，以及它认得哪些模型"""
    try:
        d = _request("/api/tags", timeout=timeout)
        names = [m.get("name") or m.get("model") for m in (d.get("models") or [])]
        return True, [n for n in names if n]
    except Exception:  # noqa: BLE001
        return False, []


def _find_ollama_exe():
    exe = shutil.which("ollama")
    if exe:
        return exe
    candidate = os.path.join(
        os.environ.get("LOCALAPPDATA", ""), "Programs", "Ollama", "ollama.exe"
    )
    if os.path.exists(candidate):
        return candidate
    # 系统级安装（管理员安装包）会落在 Program Files
    candidate = os.path.join(os.environ.get("ProgramFiles", ""), "Ollama", "ollama.exe")
    return candidate if os.path.exists(candidate) else None


def start_ollama(wait=25):
    """拉起 ollama serve，并让它的模型目录指向项目的 models/qwen"""
    exe = _find_ollama_exe()
    if not exe:
        return False, "找不到 ollama，请先安装（winget install Ollama.Ollama）"

    env = os.environ.copy()
    env["OLLAMA_MODELS"] = MODELS_DIR
    env["OLLAMA_HOST"] = OLLAMA_BIND
    try:
        subprocess.Popen(
            [exe, "serve"],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception as e:  # noqa: BLE001
        return False, f"启动 ollama 失败：{e}"

    for _ in range(wait):
        time.sleep(1)
        ok, _ = probe(timeout=3)
        if ok:
            return True, f"ollama 已启动（模型目录 {MODELS_DIR}）"
    return False, "ollama 启动超时，请手动启动后再试"


class QwenSolver:
    """对 Ollama 的一次 chat 调用包装"""

    def __init__(self, model=None, timeout=360):
        self.model = model or DEFAULT_MODEL
        self.timeout = timeout

    @staticmethod
    def fit_input(page_text, transcript, question=None):
        """按上下文单位裁剪，优先保留录音文本和补充要求。

        页面过长时保留开头和结尾：题干常在开头，选项/提问常在末尾，
        只保留前半段会恰好把答案选项切掉。中文按 4 倍单位计，避免
        中文长页面把本地 8192 token 的上下文挤爆。
        """
        page = (page_text or "").strip()
        transcript = (transcript or "").strip()
        question = (question or "").strip()
        fixed = _units(transcript) + _units(question)
        page_budget = max(2000, MAX_INPUT_CHARS - fixed)
        if _units(page) <= page_budget:
            return page, transcript, question, False

        # 二分找「头 65% + 尾 35%」能放下的最长字符数
        lo, hi, best = 0, len(page), 0
        while lo <= hi:
            mid = (lo + hi) // 2
            head = int(mid * 0.65)
            tail = mid - head
            cand = page[:head] + (page[-tail:] if tail else "")
            if _units(cand) <= page_budget:
                best = mid
                lo = mid + 1
            else:
                hi = mid - 1
        best = max(200, min(best, len(page)))
        head = int(best * 0.65)
        tail = best - head
        page = (
            page[:head]
            + "\n\n[页面中段因上下文长度限制已省略]\n\n"
            + (page[-tail:] if tail else "")
        )
        return page, transcript, question, True

    def build_messages(self, page_text, transcript, question=None):
        page, transcript, question, _ = self.fit_input(page_text, transcript, question)
        page = page or "（无）"
        transcript = transcript or "（无）"
        q = ""
        if question:
            q = f"\n【补充说明】\n{question}\n"
        return [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": USER_TEMPLATE.format(
                    page=page, transcript=transcript, question=q
                ),
            },
        ]

    def solve(self, page_text, transcript, question=None, model=None):
        """返回中文解答文本；失败抛异常"""
        payload = {
            "model": model or self.model,
            "messages": self.build_messages(page_text, transcript, question),
            "stream": False,
            # 普通作答模式：关闭 thinking，直接生成最终答案。
            "think": False,
            # 9B 模型冷加载约 50 秒，给足保活时间，避免每次都重新加载
            "keep_alive": "10m",
            "options": {
                "num_ctx": NUM_CTX,
                "num_predict": NUM_PREDICT,
                "temperature": 0.2,
            },
        }
        d = _request("/api/chat", payload, timeout=self.timeout)
        msg = d.get("message") or {}
        text = (msg.get("content") or "").strip()
        if not text:
            reason = d.get("done_reason") or "未知原因"
            raise RuntimeError(f"模型未生成最终答案（{reason}）")
        return text


class CloudSolver:
    """调用 OpenAI-compatible Chat Completions API。"""

    def __init__(self, base_url, api_key, model, timeout=180):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout = timeout

    def solve(self, page_text, transcript, question=None, html=None):
        page, transcript, question, truncated = QwenSolver.fit_input(page_text, transcript, question)
        q = f"\n【补充说明】\n{question}\n" if question else ""
        content = [{"type": "text", "text": USER_TEMPLATE.format(
            page=page or "（无）", transcript=transcript or "（无）", question=q
        )}]
        if html:
            content.append({"type": "text", "text": f"\n【当前页面完整 HTML】\n{html}"})
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": content},
            ],
            "stream": False,
            "temperature": 0.2,
        }
        req = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"},
            method="POST",
        )
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req, timeout=self.timeout) as resp:
            result = json.loads(resp.read().decode("utf-8"))
        choices = result.get("choices") or []
        message = choices[0].get("message") or {} if choices else {}
        text = message.get("content") or ""
        if isinstance(text, list):
            text = "".join(part.get("text", "") for part in text if isinstance(part, dict))
        text = text.strip()
        if not text:
            raise RuntimeError("云端模型没有返回答案")
        return text, truncated


_engine = None
_engine_err = None


def get_engine():
    """懒加载单例；模型不可用时返回 None（错误记在 _engine_err）"""
    global _engine, _engine_err
    if _engine is not None:
        return _engine
    _engine_err = None

    if not os.path.isdir(MODELS_DIR):
        _engine_err = f"缺少模型目录：{MODELS_DIR}"
        _log(_engine_err)
        return None

    up, models = probe()
    if not up:
        ok, msg = start_ollama()
        _log(msg)
        if not ok:
            _engine_err = msg
            return None
        up, models = probe()

    wanted = detect_model_name() or DEFAULT_MODEL
    if models and wanted not in models:
        # 已跑着的 Ollama 用的是别的模型目录，退而求其次用它能找到的 qwen
        fallback = next((m for m in models if "qwen" in m.lower()), None)
        if fallback:
            _log(f"模型 {wanted} 不在本地列表，改用 {fallback}")
            wanted = fallback
        else:
            _engine_err = f"Ollama 里没有 {wanted}，也没有其它 qwen 模型（现有：{', '.join(models) or '空'}）"
            _log(_engine_err)
            return None

    _engine = QwenSolver(model=wanted)
    _log(f"做题引擎就绪：{wanted}")
    return _engine


def engine_error():
    return _engine_err


if __name__ == "__main__":
    eng = get_engine()
    if eng is None:
        print("做题引擎不可用：", engine_error())
    else:
        print(eng.solve(
            "Which planet is known as the Red Planet? A) Venus B) Mars C) Jupiter",
            "which planet is known as the red planet",
        ))
