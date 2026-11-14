"""Extract independent roof and stone materials from the approved warm concept.

Build with Python 3 and Pillow. The atlas contains no tanks, base, or assembled
street layout. Coordinates are shared with warm-city-src/renderer.js.
"""
from functools import lru_cache
from pathlib import Path
from random import Random

from PIL import Image, ImageStat

here = Path(__file__).resolve().parent
source = Image.open(here / '../../art-directions/warm-town.png').convert('RGB')
regions = [
    ((241, 120, 585, 466), (0, 0)),        # trade quarter
    ((680, 19, 916, 382), (349, 0)),       # market hall
    ((1017, 314, 1548, 599), (590, 0)),    # east upper wing
    ((1019, 703, 1384, 855), (590, 291)),  # east lower houses
    ((1064, 20, 1313, 162), (0, 352)),    # north houses
    ((241, 626, 416, 854), (253, 368)),   # southwest house
    ((442, 727, 632, 855), (658, 449)),   # town hall
    ((3, 111, 81, 438), (962, 289)),      # west edge houses
    ((1475, 20, 1558, 222), (1042, 289)), # northeast edge house
    ((838, 636, 973, 802), (1128, 365)),  # plaza stone
    ((717, 590, 803, 676), (1128, 532)),  # plaza relief
    ((360, 269, 575, 344), (434, 516)),   # court stone
]


def cobbles():
    """Make a seamless square from independent sunlit street samples."""
    rng = Random(10944)
    cells, span, overlap = 6, 92, 14
    stamp = span + overlap
    patches = [(91, 90, 213, 437), (94, 483, 234, 907), (1392, 591, 1549, 893), (395, 0, 662, 108)]
    colors = (201, 168, 135)

    @lru_cache(maxsize=cells * cells)
    def patch(row, col):
        # Each random selection is tied to its tile, independent of port order.
        sample = Random(seed[row][col])
        left, top, right, bottom = sample.choice(patches)
        x, y = sample.randint(left, right - stamp), sample.randint(top, bottom - stamp)
        image = source.crop((x, y, x + stamp, y + stamp))
        mean = ImageStat.Stat(image).mean
        image = Image.merge('RGB', [band.point(lambda value, n=n: max(0, min(255, round((value - mean[n]) * 1.14 + colors[n]))))
                                    for n, band in enumerate(image.split())])
        return image.load()

    seed = [[rng.randrange(1_000_000) for _ in range(cells)] for _ in range(cells)]
    texture = Image.new('RGB', (cells * span, cells * span))
    result = texture.load()
    for y in range(texture.height):
        row, sy = divmod(y, span)
        wy = min((sy + .5) / overlap, 1)
        wy = wy * wy * (3 - 2 * wy)
        for x in range(texture.width):
            col, sx = divmod(x, span)
            a = patch(row, col)[sx, sy]
            if sx >= overlap and sy >= overlap:
                result[x, y] = a
                continue
            wx = min((sx + .5) / overlap, 1)
            wx = wx * wx * (3 - 2 * wx)
            up, left = (row - 1) % cells, (col - 1) % cells
            b = patch(row, left)[sx + span, sy] if wx < 1 else a
            c = patch(up, col)[sx, sy + span] if wy < 1 else a
            d = patch(up, left)[sx + span, sy + span] if wx < 1 and wy < 1 else a
            result[x, y] = tuple(round((a[i] * wx + b[i] * (1 - wx)) * wy
                                       + (c[i] * wx + d[i] * (1 - wx)) * (1 - wy)) for i in range(3))
    return texture


atlas = Image.new('RGB', (1266, 1178), (121, 86, 58))
masonry = cobbles()
packed_boxes = [(0, 624, masonry.width, 624 + masonry.height)]
for box, point in regions:
    left, top = point
    right, bottom = left + box[2] - box[0], top + box[3] - box[1]
    if right > atlas.width or bottom > atlas.height or any(left < r and right > l and top < b and bottom > t for l, t, r, b in packed_boxes):
        raise ValueError(f'Atlas region overlapping or outside image: {box} at {point}')
    packed_boxes.append((left, top, right, bottom))
    atlas.paste(source.crop(box), point)
atlas.paste(masonry, packed_boxes[0][:2])
atlas.save(here / 'materials.webp', quality=93, method=6)
