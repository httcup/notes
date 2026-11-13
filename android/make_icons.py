#!/usr/bin/env python3
"""把网页的 512 图标切成 Android 各密度 mipmap 图标。"""
from PIL import Image
import os

SRC = os.path.join(os.path.dirname(__file__), '..', 'public', 'icon-512.png')
BASE = os.path.join(os.path.dirname(__file__), 'app', 'src', 'main', 'res')
SIZES = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}

src = Image.open(SRC).convert('RGBA')
for dpi, px in SIZES.items():
    d = os.path.join(BASE, 'mipmap-' + dpi)
    os.makedirs(d, exist_ok=True)
    src.resize((px, px), Image.LANCZOS).save(os.path.join(d, 'ic_launcher.png'), optimize=True)
print('图标已生成：' + ', '.join(f'{k}={v}px' for k, v in SIZES.items()))
