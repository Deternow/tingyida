# -*- coding: utf-8 -*-
"""下载英文 Vosk 模型（约 39MB）到本工作空间的 models\\vosk

用法：
    python server/install_asr_model.py
"""

import os
import zipfile

# 一律装在工作空间内，整个目录拷走即可用
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET_DIR = os.path.join(BASE_DIR, "models", "vosk")

URL = "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip"
ZIP_PATH = os.path.join(TARGET_DIR, "vosk-model-small-en-us-0.15.zip")
MODEL_DIR = os.path.join(TARGET_DIR, "vosk-model-small-en-us-0.15")


def download():
    import urllib.request

    os.makedirs(TARGET_DIR, exist_ok=True)
    tmp = ZIP_PATH + ".part"
    with urllib.request.urlopen(URL, timeout=120) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length", 0))
        got = 0
        while True:
            chunk = r.read(1024 * 256)
            if not chunk:
                break
            f.write(chunk)
            got += len(chunk)
            pct = got * 100 // total if total else 0
            print(f"\r下载中 {got/1048576:.1f}MB / {total/1048576:.1f}MB ({pct}%)", end="")
    os.replace(tmp, ZIP_PATH)
    print("\n下载完成")


def main():
    os.makedirs(TARGET_DIR, exist_ok=True)
    if os.path.isdir(MODEL_DIR):
        print("英文模型已存在:", MODEL_DIR)
        return
    if not os.path.exists(ZIP_PATH):
        print("下载英文模型…（官方源较慢，请耐心等待）")
        download()
    print("解压中…")
    with zipfile.ZipFile(ZIP_PATH) as z:
        z.extractall(TARGET_DIR)
    print("完成:", MODEL_DIR)


if __name__ == "__main__":
    main()
