# -*- coding: utf-8 -*-
"""
build_deck.py — VibeUbi 產品簡報 (PPTX)

Design system, applied to every slide so the file works as a template:
  grid      left margin 0.85", content 11.6" wide, 16:9
  colour    ink on cool paper; ONE signal red; a deep green for results only
  type      one family (微軟正黑體 / PingFang TC) carried by SIZE and WEIGHT,
            because a display face that is not installed silently becomes
            something else on the presenter's machine — and a deck is opened
            on a machine you do not control.
  numbers   Consolas, so figures line up in columns
"""
from pptx import Presentation
from pptx.util import Inches as In, Pt, Emu
from pptx.dml.color import RGBColor as C
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
from copy import deepcopy
from lxml import etree

PAPER  = C(0xF3,0xF4,0xF6); SURFACE= C(0xFF,0xFF,0xFF)
INK    = C(0x14,0x16,0x1A); INK2   = C(0x3A,0x40,0x49); MUTED = C(0x64,0x6C,0x78)
RULE   = C(0xD3,0xD8,0xDE); RULE2  = C(0xE6,0xE9,0xED)
STOP   = C(0xB8,0x32,0x2A); STOPBG = C(0xFA,0xEC,0xEB)
GO     = C(0x2C,0x63,0x49); GOBG   = C(0xEA,0xF2,0xEE)
MARK   = C(0x2A,0x4D,0x72); MARKBG = C(0xEC,0xF0,0xF5)
DARK   = C(0x14,0x16,0x1A); DARK2  = C(0x1E,0x22,0x29)

SANS = "Microsoft JhengHei"      # 微軟正黑體 — the one TC face present on stock Windows
MONO = "Consolas"
L, TOP, W = In(0.85), In(0.62), In(11.63)

prs = Presentation()
prs.slide_width, prs.slide_height = In(13.333), In(7.5)
BLANK = prs.slide_layouts[6]

def _ea(run, name):
    """Set the East Asian typeface too.

    python-pptx writes only the latin typeface, so without this every Chinese
    glyph falls back to whatever the theme picked. And the EA face must NEVER be
    the mono face: Consolas carries no CJK, so a label like 「痛點 二」 set in it
    renders as fallback boxes — caught by rendering the deck and looking at it,
    which is the only way this class of bug is ever caught.
    """
    rPr = run._r.get_or_add_rPr()
    ns = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
    ea_name = SANS if name == MONO else name
    for tag, val in (("ea", ea_name), ("cs", ea_name)):
        el = rPr.find(ns + tag)
        if el is None:
            el = etree.SubElement(rPr, ns + tag)
        el.set("typeface", val)

def box(s, x, y, w, h, fill=None, line=None, lw=1.0, radius=None):
    shp = s.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE if radius else MSO_SHAPE.RECTANGLE, x, y, w, h)
    if radius is not None:
        shp.adjustments[0] = radius
    shp.shadow.inherit = False
    if fill: shp.fill.solid(); shp.fill.fore_color.rgb = fill
    else:    shp.fill.background()
    if line: shp.line.color.rgb = line; shp.line.width = Pt(lw)
    else:    shp.line.fill.background()
    shp.text_frame.text = ""
    return shp

def text(s, x, y, w, h, runs, size=16, color=INK2, bold=False, font=SANS,
         align=PP_ALIGN.LEFT, spacing=1.32, anchor=MSO_ANCHOR.TOP, space_after=0):
    """`runs` is a string, or a list of paragraphs; a paragraph is a string or
    a list of (text, {overrides}) so one line can carry two weights."""
    tb = s.shapes.add_textbox(x, y, w, h); tf = tb.text_frame
    tf.word_wrap = True; tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = anchor
    paras = runs if isinstance(runs, list) else [runs]
    for i, para in enumerate(paras):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.line_spacing = spacing
        p.space_after = Pt(space_after)
        pieces = para if isinstance(para, list) else [(para, {})]
        for t, ov in pieces:
            r = p.add_run(); r.text = t
            f = r.font
            f.name = ov.get("font", font); f.size = Pt(ov.get("size", size))
            f.bold = ov.get("bold", bold); f.color.rgb = ov.get("color", color)
            if "spc" in ov:
                r._r.get_or_add_rPr().set("spc", str(int(ov["spc"] * 100)))
            _ea(r, ov.get("font", font))
    return tb

def rule(s, x, y, w, color=RULE, h=Pt(1)):
    ln = box(s, x, y, w, h, fill=color); return ln

# ── slide chrome ──────────────────────────────────────────────────────────
page_no = [0]
def slide(kind="content", num=None, eyebrow=None, title=None):
    s = prs.slides.add_slide(BLANK)
    bg = DARK if kind in ("title", "divider", "close") else PAPER
    box(s, 0, 0, prs.slide_width, prs.slide_height, fill=bg)
    if kind == "content":
        page_no[0] += 1
        if eyebrow:
            text(s, L, TOP, W, In(0.3), [[(eyebrow, {"color": STOP, "font": MONO, "size": 11.5, "bold": True, "spc": 1.6})]])
        if title:
            text(s, L, TOP + In(0.32), W, In(0.8), [[(title, {"size": 31, "bold": True, "color": INK})]], spacing=1.22)
            rule(s, L, TOP + In(1.12), W)
        text(s, prs.slide_width - In(1.5), prs.slide_height - In(0.62), In(0.65), In(0.3),
             [[(f"{page_no[0]:02d}", {"font": MONO, "size": 10.5, "color": MUTED})]], align=PP_ALIGN.RIGHT)
        text(s, L, prs.slide_height - In(0.62), In(4), In(0.3),
             [[("VibeUbi", {"font": MONO, "size": 10.5, "color": MUTED, "spc": 1.0})]])
    return s

BODY = TOP + In(1.45)   # where content starts on a content slide

# ══ 1 · title ═════════════════════════════════════════════════════════════
s = slide("title")
box(s, 0, 0, In(0.22), prs.slide_height, fill=STOP)
text(s, In(1.3), In(1.85), In(10), In(0.4),
     [[("VIBEUBI · 產品說明", {"font": MONO, "size": 13, "color": C(0x8A,0x92,0x9E), "spc": 2.4})]])
text(s, In(1.3), In(2.35), In(10.5), In(2.0),
     [[("不靠記得的", {"size": 60, "bold": True, "color": C(0xF2,0xF4,0xF6)})],
      [("上線閘門", {"size": 60, "bold": True, "color": C(0xF2,0xF4,0xF6)})]], spacing=1.1)
rule(s, In(1.3), In(4.62), In(2.6), color=STOP, h=Pt(2.5))
text(s, In(1.3), In(4.95), In(9.2), In(1.1),
     [[("軟體出事，很少是因為有人做錯。", {"size": 19, "color": C(0xC2,0xC8,0xD0)})],
      [("多半是因為", {"size": 19, "color": C(0xC2,0xC8,0xD0)}),
       ("沒有人記得那件事存在", {"size": 19, "bold": True, "color": C(0xF2,0xF4,0xF6)}),
       ("。", {"size": 19, "color": C(0xC2,0xC8,0xD0)})]], spacing=1.55)
text(s, In(1.3), In(6.55), In(10), In(0.3),
     [[("給非技術讀者　·　所有數字皆為實測　·　2026-09-14", {"font": MONO, "size": 11, "color": C(0x64,0x6C,0x78)})]])

# ══ 2 · divider — 痛點 ════════════════════════════════════════════════════
s = slide("divider")
text(s, In(1.3), In(2.7), In(10), In(0.4),
     [[("01 — PAIN", {"font": MONO, "size": 13, "color": STOP, "spc": 2.4})]])
text(s, In(1.3), In(3.2), In(11), In(1.6),
     [[("兩個痛點", {"size": 52, "bold": True, "color": C(0xF2,0xF4,0xF6)})]])
rule(s, In(1.3), In(4.75), In(2.6), color=STOP, h=Pt(2.5))
text(s, In(1.3), In(5.05), In(10), In(0.8),
     [[("一個讓你花時間，一個讓你賠掉信任。", {"size": 18, "color": C(0xC2,0xC8,0xD0)})]])

# ══ 3 · 痛點一 ════════════════════════════════════════════════════════════
s = slide("content", eyebrow="痛點 一", title="專案越長越大，而測試還是用手測")
text(s, L, BODY, In(6.6), In(3.4),
     [[("用 AI 寫程式，功能長得非常快。", {"size": 17.5, "color": INK2})],
      [("", {"size": 6})],
      [("但更關鍵的是：", {"size": 17.5, "color": INK2}),
       ("多數使用的人不是工程師", {"size": 17.5, "bold": True, "color": INK}),
       ("。", {"size": 17.5, "color": INK2})],
      [("", {"size": 6})],
      [("所以每更新一個功能，驗證的方式就是", {"size": 17.5, "color": INK2}),
       ("打開畫面、一個一個點過去", {"size": 17.5, "bold": True, "color": STOP}),
       ("。", {"size": 17.5, "color": INK2})],
      [("", {"size": 10})],
      [("功能十個的時候，還點得完。", {"size": 17.5, "color": INK2})],
      [("功能一百個的時候，你只會點你「這次改到的那幾個」。", {"size": 17.5, "color": INK2})],
      ], spacing=1.5)
text(s, L, BODY + In(3.35), In(6.6), In(1.0),
     [[("結果就是：專案還在長，但", {"size": 19, "color": INK}),
       ("能確認它是好的範圍在縮小", {"size": 19, "bold": True, "color": STOP}),
       ("。", {"size": 19, "color": INK})]], spacing=1.45)

bx = box(s, L + In(7.05), BODY - In(0.1), In(4.58), In(4.1), fill=SURFACE, line=RULE)
text(s, L + In(7.35), BODY + In(0.2), In(4.0), In(0.3),
     [[("手測成本，隨功能數變化", {"font": MONO, "size": 10.5, "color": MUTED, "spc": 1.2})]])
rows = [("10 個功能", "點得完", 0.16, MUTED),
        ("30 個功能", "開始挑著點", 0.42, INK2),
        ("60 個功能", "只點改到的", 0.72, STOP),
        ("100 個功能", "放棄，上線再說", 1.00, STOP)]
y = BODY + In(0.72)
for label, note, frac, col in rows:
    text(s, L + In(7.35), y, In(1.5), In(0.3), [[(label, {"size": 13, "color": INK2})]])
    box(s, L + In(8.95), y + In(0.055), In(2.3), In(0.17), fill=RULE2)
    box(s, L + In(8.95), y + In(0.055), Emu(int(In(2.3) * frac)), In(0.17), fill=col)
    text(s, L + In(7.35), y + In(0.34), In(3.9), In(0.28), [[(note, {"size": 12, "color": col, "bold": frac >= 0.72})]])
    y += In(0.83)
text(s, L + In(7.35), BODY + In(3.42), In(4.0), In(0.5),
     [[("涵蓋範圍不是被決定的，是被", {"size": 12.5, "color": MUTED}),
       ("時間耗掉的", {"size": 12.5, "color": STOP, "bold": True})]], spacing=1.4)

# ══ 4 · 痛點二 ════════════════════════════════════════════════════════════
s = slide("content", eyebrow="痛點 二", title="問題始終都在，只是還沒有人踩到")
text(s, L, BODY, In(6.55), In(2.2),
     [[("沒有人做錯事。", {"size": 17.5, "color": INK2})],
      [("只是有一件事", {"size": 17.5, "color": INK2}),
       ("沒有人記得它存在", {"size": 17.5, "bold": True, "color": INK}),
       ("。", {"size": 17.5, "color": INK2})],
      [("", {"size": 8})],
      [("它不會自己跳出來。它會一直安靜地在那裡，", {"size": 17.5, "color": INK2})],
      [("直到", {"size": 17.5, "color": INK2}),
       ("客戶真的去用了那個功能", {"size": 17.5, "bold": True, "color": STOP}),
       ("。", {"size": 17.5, "color": INK2})],
      ], spacing=1.5)
box(s, L, BODY + In(2.25), In(6.55), In(0.9), fill=STOPBG, line=STOP, lw=0.75)
text(s, L + In(0.28), BODY + In(2.42), In(6.0), In(0.6),
     [[("問題不是「出現」，是「被發現」。", {"size": 17, "bold": True, "color": STOP})],
      [("在那之前，它一直都在。", {"size": 14.5, "color": INK2})]], spacing=1.35)

bx = box(s, L + In(7.05), BODY - In(0.1), In(4.58), In(4.72), fill=SURFACE, line=RULE)
box(s, L + In(7.05), BODY - In(0.1), In(0.055), In(4.72), fill=STOP)
text(s, L + In(7.4), BODY + In(0.18), In(4.0), In(0.3),
     [[("真實案例　一個上線中的系統", {"font": MONO, "size": 10.5, "color": MUTED, "spc": 1.2})]])
facts = [("66", "個功能入口被掃出來"),
         ("61", "個完全不檢查你是誰"),
         ("1", "個是「強制關掉機器上任何程式」"),
         ("F", "評等")]
y = BODY + In(0.68)
for big, note in facts:
    text(s, L + In(7.4), y, In(0.95), In(0.5), [[(big, {"font": MONO, "size": 27, "bold": True, "color": STOP})]])
    text(s, L + In(8.45), y + In(0.11), In(2.95), In(0.5), [[(note, {"size": 13, "color": INK2})]], spacing=1.3)
    y += In(0.72)
rule(s, L + In(7.4), y - In(0.02), In(3.9), color=RULE2)
text(s, L + In(7.4), y + In(0.16), In(3.95), In(1.2),
     [[("那個專案裡其實", {"size": 13.5, "color": INK2}),
       ("寫好了", {"size": 13.5, "bold": True, "color": INK}),
       ("一段「檢查你是誰」的", {"size": 13.5, "color": INK2})],
      [("程式。全專案只有一個地方提到它 ——", {"size": 13.5, "color": INK2})],
      [("在它自己的註解裡。", {"size": 13.5, "bold": True, "color": STOP})]], spacing=1.45)

# ══ 5 · 為什麼多寫測試解決不了 ════════════════════════════════════════════
s = slide("content", eyebrow="02 — 這不是測試不夠的問題", title="自動化測試降低的是單價，不是盲點")
cols = [
    ("測試自動化", "降低的是「跑一次要多少錢」。\n但「該測什麼」還是在某個人的腦袋裡。\n第 847 個功能上線了，不會有任何地方\n跳出來說「這個沒人測過」。"),
    ("人的記憶", "人記得的從來不是「全部有什麼」，\n是「我最近碰過什麼」。\n所以涵蓋率等於「上週誰剛好想起了什麼」\n—— 專案越大，它只會越差。"),
    ("AI 的記憶", "根本沒有。新對話對上週一無所知。\n對 AI 來說「靠記得」不是不可靠，\n是結構上不存在。\n而且寫的跟審的是同一個腦袋。"),
]
x = L
for i, (h, b) in enumerate(cols):
    box(s, x, BODY, In(3.65), In(3.25), fill=SURFACE, line=RULE)
    text(s, x + In(0.3), BODY + In(0.32), In(3.1), In(0.4), [[(h, {"size": 18, "bold": True, "color": MARK})]])
    text(s, x + In(0.3), BODY + In(0.92), In(3.1), In(2.2),
         [[(ln, {"size": 13.5, "color": INK2})] for ln in b.split("\n")], spacing=1.5)
    x += In(3.99)
box(s, L, BODY + In(3.5), W, In(0.92), fill=DARK)
text(s, L + In(0.42), BODY + In(3.72), In(11), In(0.5),
     [[("所以做判斷的那一層不能是 AI ——　", {"size": 18, "color": C(0xC2,0xC8,0xD0)}),
       ("VibeUbi 做判斷的核心，一行 AI 都沒有。", {"size": 18, "bold": True, "color": C(0xF2,0xF4,0xF6)})]])

# ══ 6 · 三條公理 ══════════════════════════════════════════════════════════
s = slide("content", eyebrow="03 — 原理", title="把「記得」換成三件不需要記憶的事")
text(s, L, BODY - In(0.08), W, In(0.35),
     [[("比方說：你請人幫你把一百封信寄出去，他回來說「寄好了」。", {"size": 15, "color": MUTED})]])
ax = [("A", "用清點代替記得有什麼",  "不問任何人「我們有哪些功能」，直接把整個專案翻一遍。\n存在的東西自己會被找到，不需要誰記得。", "＝ 先把一百封信全部列出來", MARK),
      ("B", "用宣告代替記得它是幹嘛的", "每個被找到的東西都要有人寫下：誰能用、多重要。\n沒有寫，本身就是一個錯誤，不是「之後再補」。", "＝ 每封信要寄給誰、掛不掛號", MARK),
      ("C", "用證據代替記得它成功了", "永遠不相信任何人回報「我做完了」。\n要從外面去看到那個事實。", "＝ 打去收件人那邊，確認信真的到了", STOP)]
y = BODY + In(0.42)
for letter, h, b, metaphor, col in ax:
    box(s, L, y, W, In(1.23), fill=SURFACE, line=RULE)
    box(s, L, y, In(0.055), In(1.23), fill=col)
    text(s, L + In(0.36), y + In(0.26), In(0.6), In(0.7), [[(letter, {"size": 34, "bold": True, "color": col})]])
    text(s, L + In(1.05), y + In(0.19), In(5.5), In(0.35), [[(h, {"size": 17, "bold": True, "color": INK})]])
    text(s, L + In(1.05), y + In(0.58), In(5.9), In(0.6),
         [[(ln, {"size": 12.5, "color": INK2})] for ln in b.split("\n")], spacing=1.4)
    box(s, L + In(7.35), y + In(0.28), In(4.05), In(0.66), fill=MARKBG if col == MARK else STOPBG)
    text(s, L + In(7.6), y + In(0.45), In(3.6), In(0.4), [[(metaphor, {"size": 13, "color": col, "bold": True})]])
    y += In(1.33)
text(s, L, y + In(0.06), W, In(0.4),
     [[("市面上大部分工具停在「他說寄了」。", {"size": 15, "color": MUTED}),
       ("　C 這一條是差別所在。", {"size": 15, "bold": True, "color": INK})]])

# ══ 7 · 不能通融的一條 ════════════════════════════════════════════════════
s = slide("content", eyebrow="03 — 唯一不能通融的規則", title="證據，必須從被部署的那個程式「外面」拿")
box(s, L, BODY, W, In(1.35), fill=DARK)
text(s, L + In(0.5), BODY + In(0.3), In(10.8), In(0.8),
     [[("「它說它成功了」不是證據。", {"size": 25, "bold": True, "color": C(0xF2,0xF4,0xF6)})],
      [("要能分辨新舊版本，而且要從外面看到。", {"size": 16, "color": C(0xC2,0xC8,0xD0)})]], spacing=1.45)
bad = ["建置指令回傳成功", "重啟指令沒有報錯", "網頁有回應（200）", "這條管線自己寫的報告"]
good = ["網頁上帶著的版本編號", "服務對外回報的版本號", "容器實際跑的映像指紋", "檔案指紋 ＋ 啟動時間"]
for i, (title_, items, col, bg) in enumerate([("不算證據", bad, STOP, STOPBG), ("才算證據", good, GO, GOBG)]):
    x = L + i * In(5.98)
    box(s, x, BODY + In(1.6), In(5.65), In(2.6), fill=SURFACE, line=RULE)
    box(s, x, BODY + In(1.6), In(5.65), In(0.52), fill=bg)
    text(s, x + In(0.3), BODY + In(1.73), In(5), In(0.3), [[(title_, {"size": 15, "bold": True, "color": col})]])
    yy = BODY + In(2.32)
    for it in items:
        text(s, x + In(0.3), yy, In(0.3), In(0.3), [[("✕" if col == STOP else "✓", {"font": MONO, "size": 13, "color": col})]])
        text(s, x + In(0.72), yy, In(4.6), In(0.3), [[(it, {"size": 14, "color": INK2})]])
        yy += In(0.44)
text(s, L, BODY + In(4.35), W, In(0.4),
     [[("因為上面左欄那些，全部都可能在", {"size": 14.5, "color": MUTED}),
       ("「新版其實根本沒換上去」", {"size": 14.5, "bold": True, "color": STOP}),
       ("的情況下，統統顯示正常。", {"size": 14.5, "color": MUTED})]])

# ══ 8 · 七步 ══════════════════════════════════════════════════════════════
s = slide("content", eyebrow="04 — 流程", title="你按下「上線」之後，實際發生的七件事")
steps = [("VERIFY","先驗","完全不碰線上，\n能驗的都先驗完",False),
         ("BUILD","建","蓋在旁邊空位，\n不蓋正在用的",False),
         ("SWAP","換","把新版本\n放上去",True),
         ("PROVE","證","從外面確認，\n現在跑的\n真的是新版",False),
         ("SWEEP","掃","對著正在跑的\n網站逐項檢查",False),
         ("GATE","判","有最高級的紅，\n就換回舊版，\n並證明換回了",True),
         ("REPORT","報","把證據\n寫下來",False)]
cw = In(1.615); gap = In(0.055); x = L
for en, zh, d, mut in steps:
    box(s, x, BODY, cw, In(2.75), fill=STOPBG if mut else SURFACE, line=RULE)
    text(s, x + In(0.2), BODY + In(0.2), cw - In(0.3), In(0.25), [[(en, {"font": MONO, "size": 9.5, "color": STOP if mut else MUTED, "spc": 1.4})]])
    text(s, x + In(0.2), BODY + In(0.48), cw - In(0.3), In(0.4), [[(zh, {"size": 22, "bold": True, "color": STOP if mut else INK})]])
    text(s, x + In(0.2), BODY + In(1.0), cw - In(0.32), In(1.3),
         [[(ln, {"size": 11.5, "color": INK2})] for ln in d.split("\n")], spacing=1.42)
    if mut:
        b = box(s, x + In(0.2), BODY + In(2.3), In(1.2), In(0.28), fill=None, line=STOP, lw=0.75)
        text(s, x + In(0.2), BODY + In(2.355), In(1.2), In(0.22), [[("動到線上", {"size": 9, "color": STOP})]], align=PP_ALIGN.CENTER)
    x += cw + gap
box(s, L, BODY + In(3.05), In(5.65), In(1.15), fill=SURFACE, line=RULE)
text(s, L + In(0.32), BODY + In(3.26), In(5.1), In(0.8),
     [[("七步裡只有兩步會改變線上系統。", {"size": 15, "bold": True, "color": INK})],
      [("其餘五步只看、不動 —— 出事只可能出在那兩格。", {"size": 13.5, "color": INK2})]], spacing=1.42)
box(s, L + In(5.98), BODY + In(3.05), In(5.65), In(1.15), fill=SURFACE, line=RULE)
text(s, L + In(6.3), BODY + In(3.26), In(5.1), In(0.8),
     [[("第 6 步發現問題時，它不是寄信通知你，", {"size": 15, "bold": True, "color": INK})],
      [("是直接把舊版換回去。你半夜不會接到電話。", {"size": 13.5, "color": INK2})]], spacing=1.42)

# ══ 9 · 怎麼用 ════════════════════════════════════════════════════════════
s = slide("content", eyebrow="05 — 怎麼用", title="四個步驟，從零到能擋")
how = [("01","先讓它認識你的專案","vibeubi plan","它會把所有功能入口、頁面、\n對外開的門列出來。","這一步不會寫進你的專案，\n用在別人的專案上也安全。"),
       ("02","看看哪些是沒人認領的","vibeubi orphans","掃到了、卻沒有人寫下它是幹嘛\n的，就是孤兒。","第一次讓人嚇到的地方。前面\n那個案例就是在這裡看到 61 個。"),
       ("03","認領：AI 寫草稿，你只修","vibeubi adopt","幾十個功能要標「誰能用、多\n重要」很痛苦，交給 AI 起草。","AI 可以把要檢查的範圍變大，\n但不能把及格標準變低。"),
       ("04","之後上線走同一條路","vibeubi ship","七步自己跑完。過了就上，\n沒過自動換回舊版。","新功能沒被認領，下次上線就變\n紅 —— 你不需要記得去補。")]
x = L
for num, h, cmd, b, you in how:
    box(s, x, BODY, In(2.82), In(4.2), fill=SURFACE, line=RULE)
    text(s, x + In(0.26), BODY + In(0.24), In(1), In(0.3), [[(num, {"font": MONO, "size": 12, "bold": True, "color": MARK, "spc": 1.2})]])
    text(s, x + In(0.26), BODY + In(0.58), In(2.35), In(0.7), [[(h, {"size": 15.5, "bold": True, "color": INK})]], spacing=1.35)
    box(s, x + In(0.26), BODY + In(1.42), In(2.3), In(0.34), fill=PAPER, line=RULE2, lw=0.75)
    text(s, x + In(0.38), BODY + In(1.49), In(2.2), In(0.25), [[(cmd, {"font": MONO, "size": 10.5, "color": INK})]])
    text(s, x + In(0.26), BODY + In(1.94), In(2.35), In(0.9),
         [[(ln, {"size": 12.5, "color": INK2})] for ln in b.split("\n")], spacing=1.42)
    rule(s, x + In(0.26), BODY + In(2.96), In(2.3), color=RULE2)
    text(s, x + In(0.26), BODY + In(3.12), In(2.4), In(1.0),
         [[("你要做的事", {"font": MONO, "size": 9.5, "color": MUTED, "spc": 1.2})]] +
         [[(ln, {"size": 11.5, "color": INK2})] for ln in you.split("\n")], spacing=1.42)
    x += In(2.95)

# ══ 10 · 場景 ═════════════════════════════════════════════════════════════
s = slide("content", eyebrow="06 — 使用場景", title="三種情況")
scn = [("情況一","你接手了一個沒人熟的專案","原本的人走了，文件不完整，你也不知道它到底有多少東西、哪些是危險的。","第一個指令不寫入任何檔案，所以你可以當天就跑，不用先取得誰的同意。"),
       ("情況二","你在用 AI 寫功能，專案每天都在長","AI 一天生出十個新功能，你不可能每天重新盤點一次。","VibeUbi 把這件事反過來：忘記，會自己變成一個錯誤，而不是安靜地變成一個漏洞。"),
       ("情況三","你要上線，但不確定會不會弄壞什麼","典型的恐懼是：改了 A，結果 B 壞了，而 B 沒有人想到要測。","因為清單是掃出來的不是想出來的，B 一定在清單上。它壞了會被擋，而且在你發現之前就已經換回舊版。")]
x = L
for who, h, b1, b2 in scn:
    box(s, x, BODY, In(3.82), In(4.2), fill=SURFACE, line=RULE)
    box(s, x, BODY, In(3.82), In(0.42), fill=MARKBG)
    text(s, x + In(0.3), BODY + In(0.11), In(3), In(0.3), [[(who, {"font": MONO, "size": 11, "color": MARK, "spc": 1.6})]])
    text(s, x + In(0.3), BODY + In(0.68), In(3.25), In(0.8), [[(h, {"size": 17, "bold": True, "color": INK})]], spacing=1.32)
    text(s, x + In(0.3), BODY + In(1.72), In(3.25), In(1.0), [[(b1, {"size": 13.5, "color": MUTED})]], spacing=1.5)
    rule(s, x + In(0.3), BODY + In(2.78), In(3.2), color=RULE2)
    text(s, x + In(0.3), BODY + In(2.96), In(3.25), In(1.1), [[(b2, {"size": 13.5, "color": INK2})]], spacing=1.5)
    x += In(3.99)

# ══ 11 · 效益 · 數字 ══════════════════════════════════════════════════════
s = slide("content", eyebrow="07 — 效益", title="實際量到的東西")
text(s, L, BODY - In(0.05), W, In(0.35),
     [[("對一個它從來沒看過、技術堆疊也完全不同的專案，第一次跑、零手動設定，", {"size": 14.5, "color": MUTED}),
       ("全程沒有寫入那個專案任何一個檔案。", {"size": 14.5, "bold": True, "color": INK})]])
big = [("66", "個功能入口\n被掃出來", STOP), ("61", "個沒有\n身分檢查", STOP),
       ("1", "把私鑰\n進了版本歷史", STOP), ("F", "第一次跑\n的評等", STOP)]
x = L
for n, note, col in big:
    box(s, x, BODY + In(0.42), In(2.82), In(1.62), fill=SURFACE, line=RULE)
    text(s, x + In(0.3), BODY + In(0.6), In(2.3), In(0.75), [[(n, {"font": MONO, "size": 40, "bold": True, "color": col})]])
    text(s, x + In(0.3), BODY + In(1.32), In(2.3), In(0.6),
         [[(ln, {"size": 12.5, "color": INK2})] for ln in note.split("\n")], spacing=1.35)
    x += In(2.95)
box(s, L, BODY + In(2.3), W, In(1.9), fill=SURFACE, line=RULE)
text(s, L + In(0.35), BODY + In(2.5), In(11), In(0.35),
     [[("順手量到、並且修掉的：上線期間網站真的沒人在服務的那段時間", {"font": MONO, "size": 10.5, "color": MUTED, "spc": 1.0})]])
tbl = [("網站中斷（app 啟動快）", "632 ms", "0 ms"),
       ("網站中斷（app 啟動慢）", "2,110 ms", "0 ms"),
       ("出事時換回舊版要多久", "要重啟一次，再斷一次線", "17 ms")]
y = BODY + In(2.92)
text(s, L + In(0.35), y, In(4), In(0.25), [[("項目", {"font": MONO, "size": 10, "color": MUTED, "spc": 1.2})]])
text(s, L + In(5.6), y, In(3), In(0.25), [[("改善前", {"font": MONO, "size": 10, "color": MUTED, "spc": 1.2})]])
text(s, L + In(9.1), y, In(2), In(0.25), [[("改善後", {"font": MONO, "size": 10, "color": MUTED, "spc": 1.2})]])
y += In(0.3)
rule(s, L + In(0.35), y, In(10.9), color=RULE)
y += In(0.14)
for name, was, now in tbl:
    text(s, L + In(0.35), y, In(5), In(0.3), [[(name, {"size": 14, "color": INK})]])
    text(s, L + In(5.6), y, In(3.4), In(0.3), [[(was, {"font": MONO, "size": 13, "color": MUTED})]])
    text(s, L + In(9.1), y, In(2.5), In(0.3), [[(now, {"font": MONO, "size": 14, "bold": True, "color": GO})]])
    y += In(0.38)

# ══ 12 · 誠實 ═════════════════════════════════════════════════════════════
s = slide("content", eyebrow="08 — 它抓到自己說謊", title="一個會對自己誠實的工具，才有資格對你的專案誠實")
box(s, L, BODY, In(5.65), In(3.2), fill=SURFACE, line=RULE)
box(s, L, BODY, In(0.055), In(3.2), fill=STOP)
text(s, L + In(0.35), BODY + In(0.28), In(5), In(0.35), [[("它抓到自己說謊", {"size": 18, "bold": True, "color": INK})]])
text(s, L + In(0.35), BODY + In(0.8), In(5.0), In(2.2),
     [[("VibeUbi 的某個元件宣稱「我可以提供合格的證據」，", {"size": 13.5, "color": INK2})],
      [("但同一份資料的說明欄位寫著「尚未接線」。", {"size": 13.5, "color": INK2})],
      [("", {"size": 6})],
      [("於是畫面上出現一個綠色的勾，", {"size": 13.5, "color": INK2})],
      [("旁邊寫著「尚未接線」。", {"size": 14.5, "bold": True, "color": STOP})],
      [("", {"size": 6})],
      [("它自己的規則把這件事擋了下來。", {"size": 13.5, "color": INK2})]], spacing=1.52)
box(s, L + In(5.98), BODY, In(5.65), In(3.2), fill=SURFACE, line=RULE)
box(s, L + In(5.98), BODY, In(0.055), In(3.2), fill=MARK)
text(s, L + In(6.33), BODY + In(0.28), In(5), In(0.35), [[("一條被它自己否決的規則", {"size": 18, "bold": True, "color": INK})]])
text(s, L + In(6.33), BODY + In(0.8), In(5.0), In(2.2),
     [[("有一條偵測「密碼被寫進日誌」的規則，", {"size": 13.5, "color": INK2})],
      [("九個警告裡只有一個是真的 —— 準確率約 ", {"size": 13.5, "color": INK2}),
       ("11%", {"font": MONO, "size": 14.5, "bold": True, "color": STOP})],
      [("", {"size": 6})],
      [("內建規定：準確率不到 90% 的規則，", {"size": 13.5, "color": INK2})],
      [("沒有資格擋任何人。", {"size": 14.5, "bold": True, "color": MARK})],
      [("", {"size": 6})],
      [("所以它被退回去重寫，而不是加例外放行。", {"size": 13.5, "color": INK2})]], spacing=1.52)
box(s, L, BODY + In(3.45), W, In(0.75), fill=DARK)
text(s, L + In(0.42), BODY + In(3.62), In(11), In(0.4),
     [[("寧可少抓一個，也不要養出「反正都是誤報」的習慣 —— 那是所有警報系統死掉的方式。", {"size": 16, "color": C(0xE9,0xEC,0xF0)})]])

# ══ 13 · 代價 ═════════════════════════════════════════════════════════════
s = slide("content", eyebrow="09 — 代價", title="它不能做什麼")
text(s, L, BODY - In(0.05), W, In(0.35),
     [[("一份只講好處的報告，本身就違反這個產品的原則。", {"size": 15, "color": MUTED})]])
costs = [("第一次要花力氣認領", "幾十個功能要一個一個確認「誰能用、多重要」。AI 可以生草稿，但確認是人的工作。\n這是一次性成本，不過它是真的成本。"),
         ("零中斷要付出兩份資源", "新舊兩個版本會同時活著，所以記憶體用量是兩倍。\n換來的是上線不斷線、還原只要 17 毫秒。這筆帳划不划算，要看你的服務。"),
         ("它不判斷你的功能做得好不好", "它只回答三個問題：這個東西存不存在、該不該被擋、有沒有真的上線。\n「這個功能設計得對不對」不在它的範圍裡，也不應該在。"),
         ("宣告錯了，它會照著錯的擋", "如果你把一個危險的功能標成「不重要」，它就會放行。\n它消除的是「忘記」，不是「判斷錯誤」—— 後者仍然需要人。")]
y = BODY + In(0.42)
for h, b in costs:
    box(s, L, y, W, In(0.86), fill=SURFACE, line=RULE)
    text(s, L + In(0.32), y + In(0.28), In(0.3), In(0.3), [[("✕", {"font": MONO, "size": 15, "color": STOP})]])
    text(s, L + In(0.78), y + In(0.13), In(3.6), In(0.35), [[(h, {"size": 15.5, "bold": True, "color": INK})]])
    text(s, L + In(4.5), y + In(0.13), In(6.9), In(0.6),
         [[(ln, {"size": 12.5, "color": INK2})] for ln in b.split("\n")], spacing=1.42)
    y += In(0.94)

# ══ 14 · close ════════════════════════════════════════════════════════════
s = slide("close")
box(s, 0, 0, In(0.22), prs.slide_height, fill=STOP)
text(s, In(1.3), In(2.5), In(11), In(2.2),
     [[("它不會讓你變聰明。", {"size": 44, "bold": True, "color": C(0xF2,0xF4,0xF6)})],
      [("它只是讓你", {"size": 44, "bold": True, "color": C(0xF2,0xF4,0xF6)}),
       ("不需要記得", {"size": 44, "bold": True, "color": STOP}),
       ("。", {"size": 44, "bold": True, "color": C(0xF2,0xF4,0xF6)})]], spacing=1.3)
rule(s, In(1.3), In(5.15), In(2.6), color=STOP, h=Pt(2.5))
text(s, In(1.3), In(5.5), In(10), In(0.9),
     [[("VibeUbi　·　117 項自動測試　·　Node 18 與 Node 22 皆通過", {"font": MONO, "size": 12.5, "color": C(0x8A,0x92,0x9E)})],
      [("本簡報所有數字均來自實際執行，非估計值", {"font": MONO, "size": 12.5, "color": C(0x8A,0x92,0x9E)})]], spacing=1.6)

prs.save("/home/ubuntu/vibeUbi/deck/VibeUbi-產品說明.pptx")
print(f"saved · {len(prs.slides.__iter__.__self__._sldIdLst)} slides")
