"""Render the approved reading-lens vectors into application icon assets."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import shutil

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'branding'
BG, INK, ACCENT, MUTED = '#272728', '#F7F1EE', '#FF6F68', '#999397'
SIZES = (16, 20, 24, 32, 48, 64, 128, 256)


def svg(tray=False):
    rows = '' if tray else (
        f'<rect x="24" y="21" width="16" height="4" rx="2" fill="{MUTED}"/>'
        f'<rect x="24" y="41" width="16" height="4" rx="2" fill="{MUTED}"/>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
            '<title>InfoLens 阅读透镜</title>'
            f'<rect width="64" height="64" rx="14" fill="{BG}"/>'
            f'<circle cx="32" cy="32" r="20" fill="none" stroke="{INK}" stroke-width="5"/>'
            + rows + f'<rect x="20" y="29" width="24" height="7" rx="2.5" fill="{ACCENT}"/></svg>\n')


def render(size, tray=False):
    # Draw the SVG geometry at 8x resolution; retain transparent outer corners.
    scale = size * 8 / 64
    im = Image.new('RGBA', (size * 8, size * 8), (0, 0, 0, 0))
    draw = ImageDraw.Draw(im)
    def box(values): return tuple(round(v * scale) for v in values)
    def rect(values, radius, fill):
        draw.rounded_rectangle(box(values), radius=round(radius * scale), fill=fill)
    rect((0, 0, 64, 64), 14, BG)
    draw.ellipse(box((9.5, 9.5, 54.5, 54.5)), fill=INK)
    draw.ellipse(box((14.5, 14.5, 49.5, 49.5)), fill=BG)
    if not tray:
        rect((24, 21, 40, 25), 2, MUTED)
        rect((24, 41, 40, 45), 2, MUTED)
    rect((20, 29, 44, 36), 2.5, ACCENT)
    return im.resize((size, size), Image.Resampling.LANCZOS)


for tray, name in ((False, 'infolens'), (True, 'infolens-tray')):
    (OUT / (name + '.svg')).write_text(svg(tray), encoding='utf8')
    for size in SIZES:
        render(size, tray).save(OUT / f'{name}-{size}.png')
    # Supply separately rendered frames rather than downscaling a single ICO frame.
    frames = [render(size, tray) for size in SIZES]
    frames[-1].save(OUT / (name + '.ico'), sizes=[(s, s) for s in SIZES], append_images=frames[:-1])

destinations = {
    'infolens.svg': [ROOT / 'infolens-prototype/assets/infolens.svg', ROOT / 'edge-extension/icons/infolens.svg'],
    'infolens.ico': [ROOT / 'windows-host/icons/infolens.ico', ROOT / 'infolens-prototype/assets/infolens.ico'],
    'infolens-tray.ico': [ROOT / 'windows-host/icons/infolens-tray.ico'],
    'infolens-128.png': [ROOT / 'vscode-extension/icon.png'],
}
for size in (16, 32, 48, 128):
    destinations.setdefault(f'infolens-{size}.png', []).append(ROOT / f'edge-extension/icons/icon{size}.png')
for source, paths in destinations.items():
    for target in paths:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(OUT / source, target)

canvas = Image.new('RGB', (880, 350), '#1b1b1d')
draw = ImageDraw.Draw(canvas)
font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 17)
heading = ImageFont.truetype('C:/Windows/Fonts/msyhbd.ttc', 25)
draw.text((36, 25), 'InfoLens · 阅读透镜', font=heading, fill=INK)
for tray, x, label in ((False, 70, '应用图标'), (True, 280, '托盘图标')):
    icon = render(112, tray)
    canvas.paste(icon, (x, 96), icon)
    draw.text((x + 56, 235), label, font=font, fill=INK, anchor='mm')
for yy, bg, text in ((102, '#303033', '#eee'), (178, '#f2eeec', '#494549')):
    draw.rounded_rectangle((490, yy, 839, yy + 56), radius=10, fill=bg)
    draw.text((506, yy + 18), '托盘', font=font, fill=text)
    for size, x in ((16, 600), (24, 669), (32, 741)):
        icon = render(size, True)
        canvas.paste(icon, (x, yy + (56 - size) // 2), icon)
draw.text((490, 255), '16 px        24 px        32 px', font=font, fill=MUTED)
draw.text((36, 308), '石墨灰 #272728   暖白 #F7F1EE   珊瑚红 #FF6F68', font=font, fill=MUTED)
canvas.save(OUT / 'infolens-approved-icons.png')
print('Generated approved SVG, PNG, multi-resolution ICO and client assets.')
