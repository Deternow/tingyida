# -*- coding: utf-8 -*-
"""下载并解压离线英译中模型（Argos en_zh 包，约 68MB）

用法：
    python server/install_translation_model.py
"""

import os
import sys
import urllib.request
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from translator import PKG_DIR, PKG_FILE, Translator  # noqa: E402

URL = "https://argos-net.com/v1/translate-en_zh-1_9.argosmodel"


def download(url, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".part"
    with urllib.request.urlopen(url, timeout=60) as r, open(tmp, "wb") as f:
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
    os.replace(tmp, dst)
    print("\n下载完成")


def main():
    if not os.path.exists(PKG_FILE):
        print(f"下载翻译模型 -> {PKG_FILE}")
        download(URL, PKG_FILE)
    else:
        print("已存在模型包，跳过下载")

    if not os.path.isdir(PKG_DIR):
        print("解压中…")
        os.makedirs(os.path.dirname(PKG_DIR), exist_ok=True)
        with zipfile.ZipFile(PKG_FILE) as z:
            z.extractall(os.path.dirname(PKG_DIR))
    print("模型目录:", PKG_DIR)

    t = Translator()
    for s in ["Hello, this is an offline translation test.", "Open the side panel and start recording."]:
        print(f"  {s}\n  -> {t.translate(s)}")


if __name__ == "__main__":
    main()
