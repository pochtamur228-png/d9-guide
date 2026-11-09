"""Рисует аватарку бота, обложку Mini App и иконку сайта «D9 Справочник».

Стиль: тёмный асфальт Пустоши, рыжая ржавчина (цвет кнопок приложения), метка на карте.
Запуск: python make_art.py  → avatar.png (640×640), cover.png (640×360), icon-180.png, icon-32.png
"""
import math
import os
import random

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = "C:/Windows/Fonts/"
RUST, RUST_DARK, RUST_LIGHT = (194, 97, 31), (120, 52, 14), (232, 140, 72)
BONE, INK = (236, 228, 214), (22, 20, 18)
random.seed(9)


def background(w, h):
    """Тёмный радиальный градиент + топографические линии + зерно."""
    img = Image.new("RGB", (w, h), INK)
    px = img.load()
    cx, cy, r = w * 0.5, h * 0.45, math.hypot(w, h) * 0.55
    for y in range(h):
        for x in range(w):
            t = min(1.0, math.hypot(x - cx, y - cy) / r)
            k = (1 - t) ** 1.6
            px[x, y] = (int(16 + 34 * k), int(16 + 28 * k), int(17 + 22 * k))
    d = ImageDraw.Draw(img, "RGBA")
    # горизонтали местности — неровные кольца
    for i in range(14):
        rr = (0.12 + i * 0.075) * min(w, h)
        pts = []
        ph = random.random() * 6.28
        for a in range(0, 361, 4):
            ang = math.radians(a)
            wob = 1 + 0.07 * math.sin(3 * ang + ph) + 0.04 * math.sin(7 * ang + ph * 2)
            pts.append((w * 0.58 + math.cos(ang) * rr * wob * 1.15, h * 0.62 + math.sin(ang) * rr * wob))
        d.line(pts, fill=(120, 96, 70, 34), width=max(1, w // 400))
    # зерно
    grain = Image.effect_noise((w, h), 22).convert("L")
    img = Image.blend(img, Image.merge("RGB", (grain, grain, grain)), 0.06)
    return img


def scratches(d, w, h, x, y, s):
    """Три следа когтей — намёк на заражённых: сужающиеся к концам полосы."""
    for i in range(3):
        ox, oy = x + i * s * 0.16, y + i * s * 0.03
        x2, y2 = ox + s * 0.42, oy + s * 0.62
        wmax = s * 0.045
        nx, ny = 0.83, -0.56  # перпендикуляр к направлению царапины
        mx, my = (ox + x2) / 2, (oy + y2) / 2
        d.polygon([(ox, oy), (mx + nx * wmax, my + ny * wmax), (x2, y2), (mx - nx * wmax, my - ny * wmax)], fill=(150, 64, 20, 170))


def pin(d, cx, cy, r, text_font):
    """Метка на карте: рыжая капля с тёмным кругом и надписью D9."""
    tip = (cx, cy + r * 1.95)
    # тень
    d.ellipse([cx - r * 0.55, tip[1] - r * 0.1, cx + r * 0.55, tip[1] + r * 0.16], fill=(0, 0, 0, 110))
    # капля: круг + треугольник к острию
    ang = math.asin(r / (tip[1] - cy))
    left = (cx - r * math.cos(ang), cy + r * math.sin(ang))
    right = (cx + r * math.cos(ang), cy + r * math.sin(ang))
    d.polygon([left, right, tip], fill=RUST_DARK)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=RUST_DARK)
    r2 = r * 0.93
    tip2 = (cx, tip[1] - r * 0.12)
    ang2 = math.asin(r2 / (tip2[1] - cy))
    d.polygon([(cx - r2 * math.cos(ang2), cy + r2 * math.sin(ang2)), (cx + r2 * math.cos(ang2), cy + r2 * math.sin(ang2)), tip2], fill=RUST)
    d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], fill=RUST)
    # блик
    d.arc([cx - r2 * 0.86, cy - r2 * 0.86, cx + r2 * 0.86, cy + r2 * 0.86], 200, 260, fill=RUST_LIGHT + (200,), width=int(r * 0.07))
    # внутренний круг
    ri = r * 0.68
    d.ellipse([cx - ri, cy - ri, cx + ri, cy + ri], fill=INK)
    d.ellipse([cx - ri, cy - ri, cx + ri, cy + ri], outline=(60, 40, 26), width=int(r * 0.03))
    # D9 — подбираем размер, чтобы надпись помещалась в тёмный круг
    size = text_font.size
    while True:
        tb = d.textbbox((0, 0), "D9", font=text_font, anchor="lt")
        if math.hypot((tb[2] - tb[0]) / 2, (tb[3] - tb[1]) / 2) <= ri * 0.86 or size < 10:
            break
        size = int(size * 0.94)
        text_font = text_font.font_variant(size=size)
    tw, th = tb[2] - tb[0], tb[3] - tb[1]
    d.text((cx - tw / 2 - tb[0], cy - th / 2 - tb[1]), "D9", font=text_font, fill=BONE)


def grunge(img, box, amount):
    """Потёртости на надписи: мелкие тёмные точки."""
    d = ImageDraw.Draw(img, "RGBA")
    x0, y0, x1, y1 = box
    for _ in range(amount):
        x, y = random.uniform(x0, x1), random.uniform(y0, y1)
        r = random.uniform(1, 4) * (x1 - x0) / 600
        d.ellipse([x - r, y - r, x + r, y + r], fill=INK + (random.randint(60, 160),))


def avatar(size=640):
    S = size * 3
    img = background(S, S)
    d = ImageDraw.Draw(img, "RGBA")
    scratches(d, S, S, S * 0.66, S * 0.12, S * 0.3)
    font = ImageFont.truetype(FONTS + "impact.ttf", int(S * 0.27))
    cx, cy, r = S * 0.5, S * 0.4, S * 0.25
    pin(d, cx, cy, r, font)
    grunge(img, (cx - r * 0.6, cy - r * 0.5, cx + r * 0.6, cy + r * 0.5), 260)
    return img.resize((size, size), Image.LANCZOS)


def cover(w=640, h=360):
    S = 3
    W, H = w * S, h * S
    img = background(W, H)
    d = ImageDraw.Draw(img, "RGBA")
    scratches(d, W, H, W * 0.86, H * 0.08, H * 0.32)
    pin(d, W * 0.2, H * 0.36, H * 0.24, ImageFont.truetype(FONTS + "impact.ttf", int(H * 0.25)))
    x = W * 0.38

    def fit(path, size, text, maxw):
        f = ImageFont.truetype(FONTS + path, size)
        while d.textlength(text, font=f) > maxw:
            size = int(size * 0.95)
            f = ImageFont.truetype(FONTS + path, size)
        return f
    room = W * 0.94 - x
    title = fit("ariblk.ttf", int(H * 0.13), "D9 Справочник", room)
    sub = fit("arial.ttf", int(H * 0.065), "напоминания и общая база игроков", room)
    d.text((x, H * 0.24), "D9 Справочник", font=title, fill=BONE)
    d.text((x, H * 0.47), "скупщики · карта · гайд", font=sub, fill=RUST_LIGHT)
    d.text((x, H * 0.58), "напоминания и общая база игроков", font=sub, fill=(170, 160, 148))
    d.rectangle([x, H * 0.43, x + W * 0.1, H * 0.43 + H * 0.012], fill=RUST)
    return img.resize((w, h), Image.LANCZOS)


if __name__ == "__main__":
    a = avatar(640)
    a.save(os.path.join(HERE, "avatar.png"), optimize=True)
    a.resize((180, 180), Image.LANCZOS).save(os.path.join(HERE, "icon-180.png"), optimize=True)
    a.resize((32, 32), Image.LANCZOS).save(os.path.join(HERE, "icon-32.png"), optimize=True)
    cover().save(os.path.join(HERE, "cover.png"), optimize=True)
    print("ok")
