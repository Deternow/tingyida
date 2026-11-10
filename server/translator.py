# -*- coding: utf-8 -*-
"""
离线英译中引擎：直接用 CTranslate2 + SentencePiece 加载 Argos 的 en_zh 包，
不经过 argostranslate / stanza，因此不需要联网下载分词模型。

包结构（translate-en_zh-1_9.argosmodel 解压后）：
    translate-en_zh-1_9/model/model.bin           CTranslate2 模型
    translate-en_zh-1_9/model/config.json
    translate-en_zh-1_9/sentencepiece.model       共享词表分词器
"""

import os
import re
import sys

_SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = (
    os.path.dirname(os.path.abspath(sys.executable))
    if getattr(sys, "frozen", False)
    else os.path.dirname(_SERVER_DIR)
)
PKG_DIR = os.path.join(BASE_DIR, "models", "en_zh", "translate-en_zh-1_9")
MODEL_DIR = os.path.join(PKG_DIR, "model")
SP_MODEL = os.path.join(PKG_DIR, "sentencepiece.model")
PKG_FILE = os.path.join(BASE_DIR, "models", "translate-en_zh-1_9.argosmodel")

# 长句切分：opus-mt 对超长输入会退化，先按句号和换行拆开
_SENT_SPLIT = re.compile(r"(?<=[.!?。！？；;])\s+|\n+")
MAX_CHARS = 160


class Translator:
    def __init__(self, model_dir=MODEL_DIR, sp_model=SP_MODEL, beam_size=4):
        import ctranslate2
        import sentencepiece

        self.tr = ctranslate2.Translator(model_dir)
        # 注意：sentencepiece 的 C++ 层读不了含中文/非 ASCII 的路径，
        # 这里直接把模型字节读进来再加载，避免 model_file 失败
        with open(sp_model, "rb") as f:
            sp_bytes = f.read()
        self.sp = sentencepiece.SentencePieceProcessor(model_proto=sp_bytes)
        self.beam_size = beam_size

    @staticmethod
    def split(text):
        """把文本切成适合翻译的小段"""
        parts = [p.strip() for p in _SENT_SPLIT.split(text) if p and p.strip()]
        out = []
        for p in parts:
            while len(p) > MAX_CHARS:
                cut = p.rfind(" ", 0, MAX_CHARS)
                cut = cut if cut > 40 else MAX_CHARS
                out.append(p[:cut].strip())
                p = p[cut:].strip()
            if p:
                out.append(p)
        return out or [text.strip()]

    def translate(self, text):
        text = (text or "").strip()
        if not text:
            return ""
        segs = self.split(text)
        inputs = [self.sp.encode(s, out_type=str) for s in segs]
        results = self.tr.translate_batch(
            inputs,
            beam_size=self.beam_size,
            max_decoding_length=256,
        )
        outs = []
        for r in results:
            hyp = r.hypotheses[0] if r.hypotheses else []
            outs.append(self.sp.decode(hyp).replace("▁", " ").strip())
        # 英文原句之间用空格拼，避免出现多余空格
        joined = "".join(outs) if any("\u4e00" <= c <= "\u9fff" for c in "".join(outs)) else " ".join(outs)
        return re.sub(r"\s{2,}", " ", joined).strip()

    def translate_batch(self, texts):
        return [self.translate(t) for t in texts]


_engine = None


def get_engine():
    """懒加载单例；模型没准备好时返回 None"""
    global _engine
    if _engine is not None:
        return _engine
    if not os.path.isdir(MODEL_DIR) or not os.path.exists(SP_MODEL):
        if os.path.exists(PKG_FILE):
            try:
                prepare_model()
            except Exception:  # noqa: BLE001
                return None
        else:
            return None
    try:
        _engine = Translator()
        return _engine
    except Exception as e:  # noqa: BLE001
        print(f"[translator] 加载失败: {e}")
        return None


def prepare_model():
    """把 .argosmodel 解压成可用的模型目录"""
    import zipfile

    if not os.path.exists(PKG_FILE):
        raise FileNotFoundError(f"缺少翻译模型包: {PKG_FILE}")
    target = os.path.dirname(PKG_DIR)
    os.makedirs(target, exist_ok=True)
    with zipfile.ZipFile(PKG_FILE) as z:
        z.extractall(target)
    return MODEL_DIR


if __name__ == "__main__":
    e = get_engine()
    if e is None:
        print("翻译模型未就绪，请先下载 translate-en_zh-1_9.argosmodel")
    else:
        for s in [
            "Hello, this is an offline translation test.",
            "Please click the record button and speak in English.",
            "The quick brown fox jumps over the lazy dog.",
        ]:
            print(s, "->", e.translate(s))
