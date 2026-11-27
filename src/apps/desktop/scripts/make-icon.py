"""The app icon: the launch page's hollow gold diamond, unplated, as a multi-size
Windows .ico for electron-builder (build-resources/icon.ico), and the Microsoft Store package's
images (build-resources/appx/, plus the 300 x 300 listing tile). Run once when the mark changes:
    python -X utf8 -I scripts/make-icon.py
A classic .ico can't follow the taskbar theme (only MSIX packages get light and dark unplated icons),
so the zip's exe, shortcuts and Start menu use the deeper launch-page gold #a9822f, which holds on
both Windows taskbars. The running window swaps its own icon by the taskbar's theme
(main.cjs `taskbarIcon`): taskbar-light.ico (#a9822f) on a light taskbar and
taskbar-dark.ico (the launch page's bright #c9a24b) on a dark one. The stroke is 1.5 of 24 from
32 px up (as drawn) and 2.25 of 24 at 24 px and below, where the drawn stroke fades.
Each diamond is drawn at 8x and downsampled.

The Store package (`pnpm msix`) takes every file in build-resources/appx/ as it is, so nothing
else goes in that folder. Windows picks a file by its name:
- Square44x44Logo.targetsize-N_altform-unplated: the taskbar, Start and the app list on a dark
  taskbar (bright gold); _altform-lightunplated: the same on a light taskbar (deep gold); the
  plain targetsize-N and scale-N files are the plated forms older Windows 10 draws on the accent
  colour (deep gold, the diamond at two thirds of the plate).
- StoreLogo: the installer and the Store (deep gold, edge to edge, as the .ico).
- Square150x150Logo and Wide310x150Logo: Windows 10's Start tiles (the diamond at half the height).
store-tile-300.png sits outside appx/ (it is uploaded to the listing, not packed): the diamond at
76 % of the tile with a 2.25 line (option B, 2026-11-27)."""
import math, os
from PIL import Image, ImageDraw

DEEP = (169, 130, 47, 255)    # #a9822f, for light taskbars (and the zip's icon)
BRIGHT = (201, 162, 75, 255)  # #c9a24b, for dark taskbars
SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
SCALES = [100, 125, 150, 200, 400]
TARGETSIZES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256]
here = os.path.dirname(os.path.abspath(__file__))
root = os.path.join(here, '..')
resources = os.path.join(root, 'build-resources')
appx = os.path.join(resources, 'appx')

def draw(size, gold, stroke24=None):
    ss = size * 8
    im = Image.new('RGBA', (ss, ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    stroke = (stroke24 or (2.25 if size <= 24 else 1.5)) / 24 * ss
    m = ss / 2
    def diamond(r):
        return [(m, m - r), (m + r, m), (m, m + r), (m - r, m)]
    d.polygon(diamond(m), fill=gold)
    d.polygon(diamond(m - stroke * math.sqrt(2)), fill=(0, 0, 0, 0))
    return im.resize((size, size), Image.LANCZOS)

def ico(path, gold):
    imgs = [draw(s, gold) for s in SIZES]
    imgs[-1].save(path, format='ICO', sizes=[(s, s) for s in SIZES], append_images=imgs[:-1])
    print(path, os.path.getsize(path))
    return imgs

def png(path, w, h, share, gold, stroke24=None):
    """A w x h transparent image with the diamond centred, its size `share` of the height."""
    size = math.floor(h * share + 0.5)
    if (h - size) % 2:
        size -= 1  # same parity as the canvas, so it centres on whole pixels
    im = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    im.paste(draw(size, gold, stroke24), ((w - size) // 2, (h - size) // 2))
    im.save(path)

imgs = ico(os.path.join(resources, 'icon.ico'), DEEP)
imgs[-1].save(os.path.join(resources, 'icon.png'))
ico(os.path.join(root, 'taskbar-light.ico'), DEEP)
ico(os.path.join(root, 'taskbar-dark.ico'), BRIGHT)

os.makedirs(appx, exist_ok=True)
for name in os.listdir(appx):
    if name.endswith('.png'):
        os.remove(os.path.join(appx, name))
for t in TARGETSIZES:
    png(os.path.join(appx, f'Square44x44Logo.targetsize-{t}.png'), t, t, 1, DEEP)
    png(os.path.join(appx, f'Square44x44Logo.targetsize-{t}_altform-unplated.png'), t, t, 1, BRIGHT)
    png(os.path.join(appx, f'Square44x44Logo.targetsize-{t}_altform-lightunplated.png'), t, t, 1, DEEP)
for s in SCALES:
    px = lambda n: math.floor(n * s / 100 + 0.5)  # half up: StoreLogo at 125 % is 63, not 62
    png(os.path.join(appx, f'Square44x44Logo.scale-{s}.png'), px(44), px(44), 2 / 3, DEEP)
    png(os.path.join(appx, f'StoreLogo.scale-{s}.png'), px(50), px(50), 1, DEEP)
    png(os.path.join(appx, f'Square150x150Logo.scale-{s}.png'), px(150), px(150), 1 / 2, DEEP)
    png(os.path.join(appx, f'Wide310x150Logo.scale-{s}.png'), px(310), px(150), 1 / 2, DEEP)
print(appx, len(os.listdir(appx)), 'files')
# The listing's tile: the Store shows it at 100 px beside the name, where an edge-to-edge outline
# stood taller than the text and read empty; the diamond at 76 % with the small sizes' heavier line.
png(os.path.join(resources, 'store-tile-300.png'), 300, 300, 0.76, DEEP, 2.25)
print(os.path.join(resources, 'store-tile-300.png'))
