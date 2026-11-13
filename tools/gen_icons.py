#!/usr/bin/env python3
"""生成 Android / iOS 用图标（PWA）：绿色圆角底 + 白色笔记本，和 mac 客户端同一套视觉。
   输出到 public/：icon-192.png、icon-512.png、icon-maskable-512.png、apple-touch-icon.png"""
import os, subprocess
from PIL import Image, ImageDraw

S = 2048
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public")

def lerp(a, b, t): return tuple(int(a[i] + (b[i]-a[i])*t) for i in range(3))

def draw_icon(pad_ratio, radius_ratio, bg_alpha=255):
    """pad_ratio: 左右留白比例；maskable 图标要留更多，保证被裁成圆形也不切内容"""
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    pad = S * pad_ratio
    r = S * radius_ratio
    grad = Image.new("RGB", (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        gd.line([(0, y), (S, y)], fill=lerp((60,154,107), (30,96,66), y/S))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((pad, pad, S-pad, S-pad), radius=r, fill=bg_alpha)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    # 笔记本：居中，占内容区约 46%
    w = (S - 2*pad) * 0.40
    h = w * 1.28
    x0, y0 = (S-w)/2, (S-h)/2
    stroke = int(S * 0.021)
    d.rounded_rectangle((x0, y0, x0+w, y0+h), radius=int(S*0.034),
                        outline=(255,255,255,255), width=stroke)
    lw = int(S*0.014)
    for i, frac in enumerate((0.33, 0.50, 0.665)):
        ly = y0 + h*frac
        lx2 = x0 + w*(0.66 if i == 2 else 0.74)
        d.line([(x0+w*0.26, ly), (lx2, ly)], fill=(255,255,255,255), width=lw)
    return img

def save(img, name, size):
    img.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name))
    print("wrote", name)

def main():
    normal = draw_icon(0.055, 0.22)      # 普通图标：接近铺满，圆角大
    maskable = draw_icon(0.14, 0.50)     # maskable：内容缩进安全区
    save(normal, "icon-192.png", 192)
    save(normal, "icon-512.png", 512)
    save(maskable, "icon-maskable-512.png", 512)
    save(normal, "apple-touch-icon.png", 180)

if __name__ == "__main__":
    main()
