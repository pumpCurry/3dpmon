#!/usr/bin/env python3
"""
3dpmon アイコン生成スクリプト
build/icon-source.png から build/icon.ico を生成する（マルチサイズ）

使い方: python scripts/make-icon.py
"""
import os
import sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "build", "icon-source.png")
OUT = os.path.join(ROOT, "build", "icon.ico")

if not os.path.exists(SRC):
    print(f"エラー: {SRC} が見つかりません", file=sys.stderr)
    sys.exit(1)

img = Image.open(SRC).convert("RGBA")
print(f"[make-icon] ソース: {SRC} ({img.size[0]}x{img.size[1]})")

# Windows アイコン推奨サイズ
sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]

img.save(OUT, format="ICO", sizes=sizes)
print(f"[make-icon] 出力: {OUT} ({os.path.getsize(OUT)} bytes, {len(sizes)}サイズ)")
