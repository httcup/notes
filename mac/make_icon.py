#!/usr/bin/env python3
"""生成 macOS 应用图标（.icns）：绿色圆角方块 + 白色笔记本，风格与网页 favicon 一致。"""
import os, subprocess, sys
from PIL import Image, ImageDraw

S = 4096          # 超采样，最后缩到各尺寸
PAD = S * 0.10    # macOS 图标网格留白
R = S * 0.225     # 圆角半径（Big Sur 风格约 22.5%）

def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def build_master():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # 阴影（柔和一点，像系统图标）
    sh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(sh)
    box = (PAD, PAD + S * 0.012, S - PAD, S - PAD + S * 0.012)
    d.rounded_rectangle(box, radius=R, fill=(0, 0, 0, 70))
    from PIL import ImageFilter
    sh = sh.filter(ImageFilter.GaussianBlur(S * 0.012))
    img = Image.alpha_composite(img, sh)

    # 渐变底色（top #3C9A6B → bottom #1E6042）
    grad = Image.new("RGB", (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        gd.line([(0, y), (S, y)], fill=lerp((60, 154, 107), (30, 96, 66), y / S))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((PAD, PAD, S - PAD, S - PAD), radius=R, fill=255)
    base = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    base.paste(grad, (0, 0), mask)
    img = Image.alpha_composite(img, base)

    # 顶部柔光
    gloss = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd2 = ImageDraw.Draw(gloss)
    gd2.rounded_rectangle((PAD, PAD, S - PAD, S * 0.52), radius=R, fill=(255, 255, 255, 26))
    img = Image.alpha_composite(img, gloss.filter(ImageFilter.GaussianBlur(S * 0.02)))

    # 笔记本：白色描边圆角页 + 三条文字线
    d = ImageDraw.Draw(img)
    w, h = S * 0.30, S * 0.385
    x0, y0 = (S - w) / 2, (S - h) / 2
    stroke = int(S * 0.026)
    d.rounded_rectangle((x0, y0, x0 + w, y0 + h), radius=int(S * 0.042),
                        outline=(255, 255, 255, 255), width=stroke)
    lw = int(S * 0.017)
    for i, frac in enumerate((0.33, 0.50, 0.67)):
        ly = y0 + h * frac
        lx2 = x0 + w * (0.66 if i == 2 else 0.72)
        d.line([(x0 + w * 0.26, ly), (lx2, ly)], fill=(255, 255, 255, 255), width=lw)
    return img

def main():
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "build", "AppIcon.iconset")
    os.makedirs(out_dir, exist_ok=True)
    master = build_master()
    sizes = [(16,1),(16,2),(32,1),(32,2),(128,1),(128,2),(256,1),(256,2),(512,1),(512,2)]
    for base, scale in sizes:
        px = base * scale
        name = f"icon_{base}x{base}{'@2x' if scale == 2 else ''}.png"
        master.resize((px, px), Image.LANCZOS).save(os.path.join(out_dir, name))
    icns = os.path.join(os.path.dirname(out_dir), "AppIcon.icns")
    subprocess.run(["iconutil", "-c", "icns", out_dir, "-o", icns], check=True)
    print("icon ready:", icns)

if __name__ == "__main__":
    main()
