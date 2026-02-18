from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import textwrap

W, H = 1080, 1350  # 4:5 ratio for better homepage balance

# Paths
root = Path(__file__).resolve().parent
assets_dir = root / 'assets'
assets_dir.mkdir(exist_ok=True)

out_png = assets_dir / 'glomcon_guangzhou_poster.png'

# Colors
navy = (11, 31, 59)        # #0B1F3B
teal = (22, 163, 163)      # #16A3A3
bg = (247, 251, 255)       # #F7FBFF
white = (255, 255, 255)
ink = (14, 23, 38)         # #0E1726
muted = (51, 65, 85)       # #334155
line = (217, 230, 242)     # #D9E6F2
chip_bg = (234, 245, 255)  # #EAF5FF
chip_border = (184, 217, 243)
amber_bg = (255, 247, 237) # #FFF7ED
amber_border = (253, 186, 116)
amber_text = (154, 52, 18)

# Fonts (CJK)
font_reg_path = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
font_bold_path = '/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc'

# Fallback to Sans bold if Serif not available
try:
    ImageFont.truetype(font_bold_path, 10)
except Exception:
    font_bold_path = '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'

F_TITLE = ImageFont.truetype(font_bold_path, 64)
F_SUB = ImageFont.truetype(font_reg_path, 30)
F_TAG = ImageFont.truetype(font_reg_path, 24)
F_H = ImageFont.truetype(font_bold_path, 34)
F_P = ImageFont.truetype(font_reg_path, 22)
F_SMALL = ImageFont.truetype(font_reg_path, 18)
F_CHIP = ImageFont.truetype(font_reg_path, 22)
F_BADGE = ImageFont.truetype(font_reg_path, 20)

img = Image.new('RGB', (W, H), bg)
d = ImageDraw.Draw(img)

# Header
header_h = 310
stripe_h = 10
d.rectangle([0, 0, W, header_h], fill=navy)
d.rectangle([0, header_h - stripe_h, W, header_h], fill=teal)

margin = 72

# Optional logo
logo_path = assets_dir / 'logo.png'
if logo_path.exists():
    try:
        logo = Image.open(logo_path).convert('RGBA')
        logo_size = 64
        logo = logo.resize((logo_size, logo_size))
        img.paste(logo, (margin, 32), logo)
        title_x = margin + logo_size + 18
    except Exception:
        title_x = margin
else:
    title_x = margin

# Title + meta

d.text((title_x, 44), 'GlomCon 中国广州会议', font=F_TITLE, fill=white)
d.text((margin, 150), '2026/6/5–6/7  ·  广州  ·  北京时间', font=F_SUB, fill=white)
d.text((margin, 200), '以真实临床问题为导向的高水平学术交流平台', font=F_TAG, fill=(214, 232, 255))

# Card helper

def rounded_card(x, y, w, h, radius=24):
    d.rounded_rectangle([x, y, x+w, y+h], radius=radius, fill=white, outline=line, width=2)

# --- Card 1: Intro
c1_y = header_h + 28
c1_h = 300
rounded_card(margin, c1_y, W - 2*margin, c1_h)

d.text((margin+28, c1_y+22), '会议简介', font=F_H, fill=ink)

intro = (
    '本次会议以真实临床问题为导向，汇聚国内外肾脏专科专家，'
    '打造覆盖肾小球疾病、肾移植内科、重症肾内与透析、AI 肾病、儿童肾病等关键亚专科的高水平学术交流平台。'
    '会议将通过主题报告、病例讨论与互动交流相结合，促进前沿证据与真实世界经验的有效转化。'
    '已邀请多位海外重磅专家加入学术阵容，嘉宾与会议日程将陆续公布。'
)

# Wrap text for card width
max_text_w = W - 2*margin - 56

# crude wrap based on character count; adjust to fit
# We'll iteratively wrap using a conservative width
wrap_width = 28
lines = textwrap.wrap(intro, width=wrap_width)

# draw
text_y = c1_y + 90
line_h = 34
for ln in lines[:6]:
    d.text((margin+28, text_y), ln, font=F_P, fill=muted)
    text_y += line_h

# --- Card 2: Topics
c2_y = c1_y + c1_h + 20
c2_h = 260
rounded_card(margin, c2_y, W - 2*margin, c2_h)

d.text((margin+28, c2_y+22), '重点议题', font=F_H, fill=ink)

topics = ['肾小球疾病', '肾移植内科', '重症肾内与透析', 'AI 肾病', '儿童肾病']

chip_x = margin + 28
chip_y = c2_y + 92
chip_gap_x = 14
chip_gap_y = 14
chip_pad_x = 18
chip_pad_y = 12

for t in topics:
    tw = d.textlength(t, font=F_CHIP)
    cw = int(tw + chip_pad_x*2)
    ch = int(22 + chip_pad_y*2)
    if chip_x + cw > (W - margin - 28):
        chip_x = margin + 28
        chip_y += ch + chip_gap_y
    d.rounded_rectangle([chip_x, chip_y, chip_x+cw, chip_y+ch], radius=18, fill=chip_bg, outline=chip_border, width=2)
    d.text((chip_x+chip_pad_x, chip_y+chip_pad_y-2), t, font=F_CHIP, fill=navy)
    chip_x += cw + chip_gap_x

# Format line
fmt = '形式：主题报告  ·  病例讨论  ·  互动交流'
d.text((margin+28, c2_y + c2_h - 54), fmt, font=F_P, fill=muted)

# --- Card 3: Registration
c3_y = c2_y + c2_h + 20
c3_h = 330
rounded_card(margin, c3_y, W - 2*margin, c3_h)

d.text((margin+28, c3_y+22), '参会与报名', font=F_H, fill=ink)

# badge
badge_text = '注册尚未开放'
bw = int(d.textlength(badge_text, font=F_BADGE) + 28*2)
bh = 42
bx = W - margin - 28 - bw
by = c3_y + 30

d.rounded_rectangle([bx, by, bx+bw, by+bh], radius=16, fill=amber_bg, outline=amber_border, width=2)
d.text((bx+28, by+10), badge_text, font=F_BADGE, fill=amber_text)

# reg text
reg_lines = [
    '敬请关注官网获取最新通知',
    '我们将陆续公布嘉宾阵容、会议日程与报名信息。',
]

d.text((margin+28, c3_y+92), reg_lines[0], font=ImageFont.truetype(font_bold_path, 28), fill=ink)
d.text((margin+28, c3_y+136), reg_lines[1], font=F_P, fill=muted)

# QR placeholder inside card
qr = 170
qr_x = W - margin - 28 - qr
qr_y = c3_y + c3_h - 28 - qr

d.rectangle([qr_x, qr_y, qr_x+qr, qr_y+qr], outline=line, width=2, fill=white)
d.text((qr_x + qr//2, qr_y + qr//2 - 14), '预留二维码', font=F_SMALL, fill=(100,116,139), anchor='mm')
d.text((qr_x + qr//2, qr_y + qr//2 + 14), '扫码关注官网', font=ImageFont.truetype(font_reg_path, 16), fill=(100,116,139), anchor='mm')

# Footer
footer_y = H - 52
footer = 'GlomCon China × KidneySphere  |  学术交流 · 病例讨论 · 真实世界经验'
d.text((margin, footer_y), footer, font=F_SMALL, fill=(71,85,105))
d.text((margin, footer_y+22), '提示：海报信息以官网最新通知为准。', font=ImageFont.truetype(font_reg_path, 15), fill=(100,116,139))

# Save
img.save(out_png, format='PNG', optimize=True)
print('Wrote', out_png)
