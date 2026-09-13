#!/usr/bin/env python3
"""Generate the Pretty Commit extension icon.

Design: a dark rounded "editor card" containing
  - left  : a commit graph  (vertical branch line + two commit nodes)
  - right : diff lines       (context / removed / added, grey-red-green)
  - topright: a small sparkle standing for the on-demand AI analysis

Rendered at a high internal resolution and downsampled with LANCZOS so it stays
crisp when VS Code draws it at 128px. The card style (inset, radius, gradient,
hairline) mirrors the sibling `word-cycle-highlight` icon so the two extensions
read as one family.

Usage:
    python3 assets/gen_icon.py
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG = os.path.join(ROOT, "images")
ASSETS = os.path.join(ROOT, "assets")

# ---- palette -------------------------------------------------------------
CARD_TOP = (44, 54, 78)          # deep indigo (editor-ish)
CARD_BOT = (17, 22, 35)
HAIRLINE = (255, 255, 255, 52)
CARD_DARK = (17, 22, 35)         # used to cut signs out of the diff bars

SLATE = (137, 152, 176)          # branch line / context bar
NODE_DIM = (150, 164, 188)       # older commit
ACCENT = (76, 154, 255)          # current commit  (#4C9AFF)
RED = (248, 81, 73)              # removed  (#F85149)
GREEN = (63, 185, 80)            # added    (#3FB950)

SPARK = (176, 219, 255)          # AI sparkle

# render size; everything is expressed as a fraction of SIDE
SIDE = 2048


FONT_SANS_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def vertical_gradient(size, top, bottom):
    """Fast vertical gradient: build a 1px-wide ramp, then stretch it."""
    w, h = size
    ramp = Image.new("RGB", (1, h))
    px = ramp.load()
    for y in range(h):
        px[0, y] = lerp(top, bottom, y / max(1, h - 1))
    return ramp.resize((w, h), Image.BILINEAR)


def rounded_card(base, box, radius, top, bottom):
    x0, y0, x1, y1 = box
    grad = vertical_gradient((x1 - x0, y1 - y0), top, bottom)
    mask = Image.new("L", grad.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, x1 - x0 - 1, y1 - y0 - 1], radius=radius, fill=255
    )
    base.paste(grad, (x0, y0), mask)


def star(draw, cx, cy, r, fill):
    """4-point sparkle (concave diamond)."""
    k = r * 0.24          # waist
    pts = [
        (cx, cy - r), (cx + k, cy - k), (cx + r, cy), (cx + k, cy + k),
        (cx, cy + r), (cx - k, cy + k), (cx - r, cy), (cx - k, cy - k),
    ]
    draw.polygon(pts, fill=fill)


def glow(img, shape, box, color, radius, blur, alpha):
    """Soft coloured halo behind a shape (drawn on its own layer)."""
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    if shape == "circle":
        d.ellipse(box, fill=color + (alpha,))
    else:
        d.rounded_rectangle(box, radius=radius, fill=color + (alpha,))
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    img.alpha_composite(layer)


def draw_icon(side=SIDE):
    W = H = side
    S = side / 1024.0                     # scale vs the 1024 design grid
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # ---- card ------------------------------------------------------------
    inset = round(56 * S)
    card = (inset, inset, W - inset, H - inset)
    radius = round(196 * S)
    rounded_card(img, card, radius, CARD_TOP, CARD_BOT)
    d.rounded_rectangle(card, radius=radius, outline=HAIRLINE, width=max(2, round(8 * S)))

    cx0, cy0, cx1, cy1 = card
    cw = cx1 - cx0
    ccy = (cy0 + cy1) / 2

    # ---- AI sparkle (top-right) -------------------------------------------
    sx, sy, sr = cx0 + cw * 0.775, cy0 + cw * 0.160, cw * 0.092
    glow(img, "circle", (sx - sr * 2.1, sy - sr * 2.1, sx + sr * 2.1, sy + sr * 2.1), SPARK, 0, sr * 0.9, 80)
    star(d, sx, sy, sr, SPARK + (255,))

    # ---- commit graph (left) ---------------------------------------------
    line_x = cx0 + cw * 0.245
    line_top = ccy - cw * 0.300
    line_bot = ccy + cw * 0.300
    line_w = cw * 0.048
    d.rounded_rectangle(
        (line_x - line_w / 2, line_top, line_x + line_w / 2, line_bot),
        radius=line_w / 2, fill=SLATE + (255,),
    )

    r_top = cw * 0.112        # the commit you opened
    r_bot = cw * 0.088        # an older one
    top_y = ccy - cw * 0.180
    bot_y = ccy + cw * 0.198

    d.ellipse((line_x - r_bot, bot_y - r_bot, line_x + r_bot, bot_y + r_bot), fill=NODE_DIM + (255,))
    glow(img, "circle",
         (line_x - r_top * 1.9, top_y - r_top * 1.9, line_x + r_top * 1.9, top_y + r_top * 1.9),
         ACCENT, 0, r_top * 0.85, 120)
    d.ellipse((line_x - r_top, top_y - r_top, line_x + r_top, top_y + r_top), fill=ACCENT + (255,))
    ir = r_top * 0.34
    d.ellipse((line_x - ir, top_y - ir, line_x + ir, top_y + ir), fill=(255, 255, 255, 245))

    # ---- diff lines (right): context / removed / added --------------------
    # 红/绿条上挖出 −/+ 符号：既是 diff 的语义，也给小尺寸提供了内部对比。
    bars = [
        (0.34, SLATE, None),     # context
        (0.46, RED, "\u2212"),   # removed
        (0.38, GREEN, "+"),      # added
    ]
    bar_h = cw * 0.128
    gap = cw * 0.086
    bars_left = cx0 + cw * 0.445
    total = len(bars) * bar_h + (len(bars) - 1) * gap
    y = ccy - total / 2

    sign_font = ImageFont.truetype(FONT_SANS_BOLD, int(bar_h * 0.86))
    for frac, color, sign in bars:
        box = (bars_left, y, bars_left + cw * frac, y + bar_h)
        d.rounded_rectangle(box, radius=bar_h / 2, fill=color + (255,))
        if sign:
            # 在条的左端挖一个符号（用卡片底色画，形成"镂空"效果）
            tx = bars_left + bar_h * 0.62
            ty = y + bar_h / 2
            d.text((tx, ty), sign, font=sign_font, fill=CARD_DARK + (255,), anchor="mm")
        y += bar_h + gap

    return img


def export():
    os.makedirs(IMG, exist_ok=True)
    big = draw_icon(SIDE)
    master = os.path.join(IMG, "icon.png")
    big.resize((512, 512), Image.LANCZOS).save(master)
    for s in (256, 128):
        big.resize((s, s), Image.LANCZOS).save(os.path.join(IMG, f"icon{s}.png"))

    # Dev-only preview sheet (not shipped): checks the icon on both themes and at
    # the sizes VS Code actually uses (marketplace 128, list 64/32, tree 16).
    sizes = [128, 64, 48, 32, 24, 16]
    cell = 150
    sheet = Image.new("RGBA", (cell * len(sizes), 320), (0, 0, 0, 0))
    d = ImageDraw.Draw(sheet)
    f = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 16)
    for row, bg in enumerate(((32, 35, 41, 255), (246, 247, 249, 255))):
        strip = Image.new("RGBA", (sheet.width, 160), bg)
        sheet.alpha_composite(strip, (0, row * 160))
        for i, s in enumerate(sizes):
            cx = i * cell + cell // 2
            cy = row * 160 + 70
            sheet.alpha_composite(big.resize((s, s), Image.LANCZOS), (cx - s // 2, cy - s // 2))
            d.text((cx, row * 160 + 132), f"{s}px", font=f,
                   fill=(190, 198, 210, 255) if row == 0 else (90, 98, 112, 255), anchor="mm")
    d.text((sheet.width - 8, 8), "dark / light", font=f, fill=(150, 158, 172, 255), anchor="ra")
    os.makedirs(ASSETS, exist_ok=True)
    sheet.save(os.path.join(ASSETS, "_preview.png"))
    print("icon written:", master)
    print("preview:", os.path.join(ASSETS, "_preview.png"))


if __name__ == "__main__":
    export()
