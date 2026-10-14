from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

OUT = os.path.dirname(os.path.abspath(__file__))
GF = '/usr/share/fonts/truetype/google-fonts/'
MONO = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'

BG = (245, 243, 238)
INK = (28, 27, 25)
MUTED = (107, 103, 95)
RUST = (193, 77, 46)
LINE = (228, 224, 214)
WHITE = (255, 255, 255)
DARK = (31, 30, 27)

SS = 2  # supersample factor


def font(name, size):
    return ImageFont.truetype(GF + name, size * SS)


def mono(size):
    return ImageFont.truetype(MONO, size * SS)


def s(v):
    return int(v * SS)


class Canvas:
    def __init__(self, w, h, bg=BG):
        self.w, self.h = w, h
        self.im = Image.new('RGB', (s(w), s(h)), bg)
        self.d = ImageDraw.Draw(self.im)

    def rect(self, box, fill=None, outline=None, r=0, width=1):
        x0, y0, x1, y1 = box
        self.d.rounded_rectangle([s(x0), s(y0), s(x1), s(y1)], radius=s(r), fill=fill,
                                 outline=outline, width=s(width) if outline else 0)

    def text(self, xy, t, f, fill=INK, anchor='la'):
        self.d.text((s(xy[0]), s(xy[1])), t, font=f, fill=fill, anchor=anchor)

    def text_w(self, t, f):
        return self.d.textlength(t, font=f) / SS

    def shadow(self, box, r=14, blur=22, offset=10, alpha=60):
        x0, y0, x1, y1 = box
        layer = Image.new('L', self.im.size, 0)
        ld = ImageDraw.Draw(layer)
        ld.rounded_rectangle([s(x0), s(y0 + offset), s(x1), s(y1 + offset)], radius=s(r), fill=alpha)
        layer = layer.filter(ImageFilter.GaussianBlur(s(blur)))
        shade = Image.new('RGB', self.im.size, (40, 30, 20))
        self.im = Image.composite(shade, self.im, layer)
        self.d = ImageDraw.Draw(self.im)

    def dashed_rect(self, box, color, dash=10, gap=7, width=3):
        x0, y0, x1, y1 = box
        def hline(y, a, b):
            x = a
            while x < b:
                self.d.line([s(x), s(y), s(min(x + dash, b)), s(y)], fill=color, width=s(width))
                x += dash + gap
        def vline(x, a, b):
            y = a
            while y < b:
                self.d.line([s(x), s(y), s(x), s(min(y + dash, b))], fill=color, width=s(width))
                y += dash + gap
        hline(y0, x0, x1); hline(y1, x0, x1); vline(x0, y0, y1); vline(x1, y0, y1)

    def save(self, name):
        self.im.resize((self.w, self.h), Image.LANCZOS).convert('RGB').save(os.path.join(OUT, name))
        print('saved', name)


def app_icon(c, x, y, size, bg=RUST, fg=BG):
    c.rect((x, y, x + size, y + size), fill=bg, r=size * 0.22)
    m = size * 0.16; L = size * 0.2; t = max(2, size * 0.075)
    for (cx, cy, dx, dy) in [(x + m, y + m, 1, 1), (x + size - m, y + m, -1, 1),
                             (x + m, y + size - m, 1, -1), (x + size - m, y + size - m, -1, -1)]:
        c.rect((min(cx, cx + dx * L), min(cy, cy + dy * t), max(cx, cx + dx * L), max(cy, cy + dy * t)), fill=fg)
        c.rect((min(cx, cx + dx * t), min(cy, cy + dy * L), max(cx, cx + dx * t), max(cy, cy + dy * L)), fill=fg)
    mid = x + size / 2; top = y + size * 0.33; bar = size * 0.34; st = size * 0.1
    c.rect((mid - bar / 2, top, mid + bar / 2, top + st), fill=fg)
    c.rect((mid - st / 2, top, mid + st / 2, y + size * 0.68), fill=fg)


def browser(c, box, url):
    x0, y0, x1, y1 = box
    c.shadow(box)
    c.rect(box, fill=WHITE, r=14)
    c.rect((x0, y0, x1, y0 + 46), fill=(236, 233, 226), r=14)
    c.rect((x0, y0 + 30, x1, y0 + 46), fill=(236, 233, 226))
    for i, col in enumerate([(236, 106, 94), (244, 190, 79), (98, 197, 84)]):
        cx = x0 + 22 + i * 20
        c.d.ellipse([s(cx - 6), s(y0 + 23 - 6), s(cx + 6), s(y0 + 23 + 6)], fill=col)
    c.rect((x0 + 90, y0 + 11, x1 - 70, y0 + 35), fill=WHITE, r=12)
    c.text((x0 + 106, y0 + 15), url, font('Poppins-Regular.ttf', 13), MUTED)
    app_icon(c, x1 - 52, y0 + 10, 26)
    return (x0, y0 + 46, x1, y1)


def toast(c, x, y, title, body, w=330):
    h = 92
    c.shadow((x, y, x + w, y + h), r=12, blur=16, offset=8, alpha=80)
    c.rect((x, y, x + w, y + h), fill=DARK, r=12)
    c.rect((x, y, x + 6, y + h), fill=(63, 154, 92))
    c.text((x + 22, y + 16), title, font('Poppins-Bold.ttf', 17), (245, 243, 238))
    c.text((x + 22, y + 46), body, font('Poppins-Regular.ttf', 14), (201, 197, 187))


def headline(c, x, y, lines, sub, size=50):
    f = font('Poppins-Bold.ttf', size)
    for i, ln in enumerate(lines):
        c.text((x, y + i * size * 1.18), ln, f, INK)
    yy = y + len(lines) * size * 1.18 + 22
    fs = font('Poppins-Regular.ttf', 22)
    for i, ln in enumerate(sub):
        c.text((x, yy + i * 34), ln, fs, MUTED)
    return yy + len(sub) * 34


def brand(c, x, y):
    app_icon(c, x, y, 34)
    c.text((x + 46, y + 4), 'Copy Text from Image', font('Poppins-Bold.ttf', 17), INK)


# ---------- Screenshot 1: right-click ----------
def shot1():
    c = Canvas(1280, 800)
    brand(c, 70, 64)
    headline(c, 70, 190, ['Right-click', 'any image.'],
             ['Pick "Copy text from image"', 'and the text is on your', 'clipboard. That\'s it.'])
    vp = browser(c, (540, 90, 1230, 720), 'design-weekly.com/posts/ship-small')
    x0, y0, x1, y1 = vp
    # article lines
    for i in range(3):
        c.rect((x0 + 40, y0 + 34 + i * 22, x0 + 40 + [460, 520, 300][i], y0 + 46 + i * 22), fill=LINE, r=6)
    # image card (quote graphic)
    ix0, iy0, ix1, iy1 = x0 + 40, y0 + 120, x0 + 420, y0 + 400
    c.rect((ix0, iy0, ix1, iy1), fill=(36, 52, 71), r=10)
    q = font('Poppins-Bold.ttf', 30)
    c.text((ix0 + 32, iy0 + 60), 'Ship small.', q, (245, 243, 238))
    c.text((ix0 + 32, iy0 + 102), 'Ship often.', q, (245, 243, 238))
    c.text((ix0 + 32, iy0 + 144), 'Learn fast.', q, (244, 190, 79))
    c.text((ix0 + 32, iy0 + 222), '@makerlog', font('Poppins-Regular.ttf', 15), (170, 182, 196))
    # context menu
    mx, my = ix0 + 250, iy0 + 120
    items = ['Open image in new tab', 'Save image as...', 'Copy image', 'Copy image address', None,
             'Copy text from image', None, 'Inspect']
    h = 30 * len([i for i in items if i]) + 12 * items.count(None) + 16
    c.shadow((mx, my, mx + 270, my + h), r=10, blur=14, offset=6, alpha=70)
    c.rect((mx, my, mx + 270, my + h), fill=WHITE, r=10, outline=LINE)
    yy = my + 8
    fm = font('Poppins-Regular.ttf', 14)
    for it in items:
        if it is None:
            c.rect((mx + 10, yy + 5, mx + 260, yy + 6), fill=LINE); yy += 12; continue
        if it == 'Copy text from image':
            c.rect((mx + 6, yy, mx + 264, yy + 30), fill=(250, 232, 225), r=6)
            app_icon(c, mx + 14, yy + 6, 18)
            c.text((mx + 40, yy + 6), it, font('Poppins-Medium.ttf', 14), RUST)
        else:
            c.text((mx + 40, yy + 6), it, fm, INK)
        yy += 30
    # cursor
    cx, cy = mx - 4, my - 6
    c.d.polygon([(s(cx), s(cy)), (s(cx), s(cy + 22)), (s(cx + 6), s(cy + 17)), (s(cx + 11), s(cy + 26)),
                 (s(cx + 14), s(cy + 25)), (s(cx + 9), s(cy + 16)), (s(cx + 16), s(cy + 16))], fill=INK, outline=WHITE)
    c.save('screenshot-1-right-click.png')


# ---------- Screenshot 2: drag over anything ----------
def shot2():
    c = Canvas(1280, 800)
    brand(c, 70, 64)
    headline(c, 70, 190, ['Or drag over', 'anything.'],
             ['Press Cmd+Shift+Y and drag', 'over any part of the page:', 'video frames, charts, locked text.'])
    vp = browser(c, (540, 90, 1230, 720), 'youtube.com/watch?v=build-a-cli')
    x0, y0, x1, y1 = vp
    # video player
    px0, py0, px1, py1 = x0 + 30, y0 + 26, x1 - 30, y0 + 400
    c.rect((px0, py0, px1, py1), fill=(22, 24, 29), r=8)
    code = ['import { readFile } from "node:fs/promises";', '',
            'const config = JSON.parse(', '  await readFile("config.json", "utf8")', ');',
            'console.log(config.name);']
    fmono = mono(16)
    for i, ln in enumerate(code):
        col = (198, 160, 246) if ln.startswith('import') else (230, 230, 230)
        c.text((px0 + 36, py0 + 40 + i * 30), ln, fmono, col)
    c.rect((px0, py1 - 36, px1, py1), fill=(10, 10, 12), r=8)
    c.rect((px0 + 16, py1 - 20, px1 - 16, py1 - 16), fill=(70, 70, 75), r=2)
    c.rect((px0 + 16, py1 - 20, px0 + 260, py1 - 16), fill=(230, 50, 50), r=2)
    # selection overlay
    sx0, sy0, sx1, sy1 = px0 + 24, py0 + 28, px0 + 470, py0 + 214
    ov = Image.new('RGBA', c.im.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(ov)
    od.rectangle([s(sx0), s(sy0), s(sx1), s(sy1)], fill=(193, 77, 46, 40))
    c.im = Image.alpha_composite(c.im.convert('RGBA'), ov).convert('RGB'); c.d = ImageDraw.Draw(c.im)
    c.dashed_rect((sx0, sy0, sx1, sy1), RUST)
    # title lines under video
    c.rect((x0 + 30, y0 + 424, x0 + 430, y0 + 444), fill=LINE, r=6)
    c.rect((x0 + 30, y0 + 456, x0 + 260, y0 + 470), fill=LINE, r=6)
    toast(c, x1 - 360, y1 - 120, 'Copied 112 characters', 'import { readFile } from "node:fs/pro...')
    c.save('screenshot-2-drag-select.png')


# ---------- Screenshot 3: private ----------
def shot3():
    c = Canvas(1280, 800)
    brand(c, 70, 64)
    headline(c, 70, 190, ['100% offline.', 'Nothing', 'uploaded.'],
             ['Text recognition runs on', 'your computer. No account,', 'no tracking.'])
    # pasted result in a notes window
    box = (560, 110, 1210, 520)
    c.shadow(box)
    c.rect(box, fill=WHITE, r=14)
    c.text((box[0] + 30, box[1] + 26), 'Notes', font('Poppins-Bold.ttf', 18), INK)
    c.rect((box[0], box[1] + 66, box[2], box[1] + 67), fill=LINE)
    fb = font('Poppins-Regular.ttf', 17)
    lines = ['Invoice total: $1,249.50', 'Due by October 15, 2026', '',
             'Ship small. Ship often. Learn fast.', '',
             'const config = JSON.parse(', '  await readFile("config.json", "utf8")', ');']
    for i, ln in enumerate(lines):
        f = mono(15) if ln.startswith(('const', '  await', ');')) else fb
        c.text((box[0] + 30, box[1] + 92 + i * 34), ln, f, INK)
    c.rect((box[0] + 30 + c.text_w(lines[-1], mono(15)) + 4, box[1] + 92 + 7 * 34, box[0] + 32 + c.text_w(lines[-1], mono(15)) + 4, box[1] + 92 + 7 * 34 + 20), fill=RUST)
    # chips
    chips = ['Works offline', 'No account', 'No tracking', 'One-time purchase']
    fx = font('Poppins-Medium.ttf', 16)
    x, y = 560, 580
    for ch in chips:
        w = c.text_w(ch, fx) + 56
        if x + w > 1210:
            x = 560; y += 60
        c.rect((x, y, x + w, y + 44), fill=WHITE, r=22, outline=LINE)
        c.d.ellipse([s(x + 16), s(y + 17), s(x + 26), s(y + 27)], fill=RUST)
        c.text((x + 36, y + 10), ch, fx, INK)
        x += w + 14
    c.save('screenshot-3-private.png')


# ---------- Small promo tile 440x280 ----------
def small_tile():
    c = Canvas(440, 280, bg=RUST)
    app_icon(c, 36, 40, 64, bg=BG, fg=RUST)
    c.text((36, 130), 'Copy Text', font('Poppins-Bold.ttf', 34), BG)
    c.text((36, 172), 'from Image', font('Poppins-Bold.ttf', 34), BG)
    c.text((36, 226), 'Offline OCR for Chrome. Nothing uploaded.', font('Poppins-Regular.ttf', 14), (250, 222, 210))
    c.save('promo-small-440x280.png')


# ---------- Marquee 1400x560 ----------
def marquee():
    c = Canvas(1400, 560)
    app_icon(c, 90, 90, 64)
    c.text((90, 190), 'Copy text from', font('Poppins-Bold.ttf', 56), INK)
    c.text((90, 256), 'any image.', font('Poppins-Bold.ttf', 56), RUST)
    fs = font('Poppins-Regular.ttf', 22)
    c.text((90, 350), 'Right-click an image or drag over anything on the page.', fs, MUTED)
    c.text((90, 384), 'Runs 100% offline. Nothing is uploaded.', fs, MUTED)
    # mini browser with selection + toast
    vp = browser(c, (820, 70, 1330, 490), 'any-website.com')
    x0, y0, x1, y1 = vp
    c.rect((x0 + 26, y0 + 24, x1 - 26, y0 + 250), fill=(36, 52, 71), r=8)
    q = font('Poppins-Bold.ttf', 26)
    c.text((x0 + 52, y0 + 70), 'Ship small.', q, BG)
    c.text((x0 + 52, y0 + 108), 'Ship often.', q, BG)
    c.text((x0 + 52, y0 + 146), 'Learn fast.', q, (244, 190, 79))
    c.dashed_rect((x0 + 40, y0 + 58, x0 + 270, y0 + 192), RUST)
    toast(c, x1 - 330, y1 - 110, 'Copied 35 characters', 'Ship small. Ship often. Learn fast.', w=310)
    c.save('promo-marquee-1400x560.png')


shot1(); shot2(); shot3(); small_tile(); marquee()
