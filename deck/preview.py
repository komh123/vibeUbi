# -*- coding: utf-8 -*-
"""Render the saved PPTX with PIL at true coordinates, so layout can be LOOKED at.

Not a fidelity renderer — a measuring one. WenQuanYi Zen Hei has CJK metrics
close enough to 微軟正黑體 that text which overflows here overflows there.
"""
from pptx import Presentation
from pptx.util import Emu
from PIL import Image, ImageDraw, ImageFont
import sys

SCALE = 110  # px per inch
CJK = "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"
MONO_F = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
cache = {}
def font(name, pt, bold, has_cjk=False):
    # mirror what PowerPoint does: the latin face applies to latin, the East
    # Asian face to CJK. A preview that ignores that lies about the deck.
    key = (name, round(pt), bold, has_cjk)
    if key not in cache:
        path = CJK if has_cjk or "Consolas" not in (name or "") else MONO_F
        cache[key] = ImageFont.truetype(path, max(6, int(pt * SCALE / 72)))
    return cache[key]

def px(e): return int(Emu(e).inches * SCALE)

prs = Presentation(sys.argv[1])
W, H = px(prs.slide_width), px(prs.slide_height)
issues = []

for idx, slide in enumerate(prs.slides, 1):
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    for shp in slide.shapes:
        x, y, w, h = px(shp.left), px(shp.top), px(shp.width), px(shp.height)
        if shp.shape_type is not None and shp.has_text_frame and shp.fill.type is not None:
            try:
                fill = shp.fill.fore_color.rgb
                d.rectangle([x, y, x + w, y + h], fill="#%02X%02X%02X" % (fill[0], fill[1], fill[2]))
            except Exception: pass
            try:
                if shp.line.color and shp.line.color.type is not None:
                    lc = shp.line.color.rgb
                    d.rectangle([x, y, x + w, y + h], outline="#%02X%02X%02X" % (lc[0], lc[1], lc[2]))
            except Exception: pass
        if not shp.has_text_frame: continue
        tf = shp.text_frame
        if not (tf.text or "").strip(): continue   # a drawn rectangle, not a text box
        cy = y
        for p in tf.paragraphs:
            runs = [r for r in p.runs if r.text]
            if not runs:
                cy += int(12 * SCALE / 72 * (p.line_spacing or 1.2)); continue
            maxpt = max((r.font.size.pt if r.font.size else 16) for r in runs)
            lh = maxpt * SCALE / 72 * (p.line_spacing or 1.25)
            # wrap manually across the runs of this paragraph
            cx = x
            for r in runs:
                fpt = r.font.size.pt if r.font.size else 16
                fnt = font(r.font.name, fpt, r.font.bold)
                col = "#000000"
                try:
                    if r.font.color and r.font.color.type is not None:
                        c = r.font.color.rgb; col = "#%02X%02X%02X" % (c[0], c[1], c[2])
                except Exception: pass
                for ch in r.text:
                    fnt = font(r.font.name, fpt, r.font.bold, ord(ch) > 0x2E80)
                    cwid = d.textlength(ch, font=fnt)
                    if cx + cwid > x + w and ch not in "。，、）」":
                        cx = x; cy += lh
                    d.text((cx, cy + (lh - fpt * SCALE / 72) * .35), ch, font=fnt, fill=col)
                    cx += cwid
            cy += lh + (p.space_after.pt * SCALE / 72 if p.space_after else 0)
        overflow = cy - (y + h)
        if overflow > 6:
            issues.append((idx, shp.shape_id, round(overflow / SCALE, 2), (shp.text_frame.text or "")[:34].replace("\n", "⏎")))
    img.save(f"/tmp/claude-1000/-home-ubuntu/f3a365ef-a37c-4aff-8acb-10415b076ec2/scratchpad/slide{idx:02d}.png")

print(f"rendered {len(prs.slides._sldIdLst)} slides")
print(f"text boxes whose content runs past their declared height: {len(issues)}")
for i in issues[:25]:
    print(f"  p{i[0]:02d}  +{i[2]}in   {i[3]}")
