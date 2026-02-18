from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from PIL import Image
from pathlib import Path

root = Path(__file__).resolve().parent
assets = root / 'assets'
img_path = assets / 'glomcon_guangzhou_poster.png'
pdf_path = assets / 'glomcon_guangzhou_poster.pdf'

im = Image.open(img_path)
W, H = im.size

c = canvas.Canvas(str(pdf_path), pagesize=(W, H))
img = ImageReader(str(img_path))
# draw full-bleed
c.drawImage(img, 0, 0, width=W, height=H, preserveAspectRatio=True, mask='auto')
c.showPage()
c.save()

print('Wrote', pdf_path)
