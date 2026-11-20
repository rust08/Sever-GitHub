"""Render the Petropavlovsk area in Web Mercator from Mapzen Terrarium elevation tiles."""
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path
from urllib.request import urlopen
from time import sleep

import numpy as np
from PIL import Image

ZOOM = 11
WEST, EAST, NORTH, SOUTH = 1922, 1931, 662, 671  # inclusive XYZ indices
ROOT = Path(__file__).resolve().parents[1]


def read_tile(tile):
    x, y = tile
    url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{ZOOM}/{x}/{y}.png"
    for attempt in range(3):
        try:
            with urlopen(url, timeout=30) as response:
                rgb = np.asarray(Image.open(BytesIO(response.read())).convert("RGB"), dtype=np.float32)
            return x, y, rgb[:, :, 0] * 256 + rgb[:, :, 1] + rgb[:, :, 2] / 256 - 32768
        except OSError:
            if attempt == 2:
                raise
            sleep(1 + attempt)


def main():
    height = np.empty(((SOUTH - NORTH + 1) * 256, (EAST - WEST + 1) * 256), dtype=np.float32)
    jobs = [(x, y) for x in range(WEST, EAST + 1) for y in range(NORTH, SOUTH + 1)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        for x, y, tile in pool.map(read_tile, jobs):
            left, top = (x - WEST) * 256, (y - NORTH) * 256
            height[top:top + 256, left:left + 256] = tile
    # At latitude 53 degrees each pixel spans approximately 46 m at this zoom.
    south_slope, east_slope = np.gradient(height, 46)
    shade = np.clip(0.65 * east_slope + 0.75 * south_slope, -0.9, 0.5)
    levels = [-1, 0, 80, 230, 500, 1100, 2100]
    palette = [[230,235,225],[230,235,225],[215,227,209],[202,218,197],
               [209,215,199],[223,218,204],[242,240,234]]
    rgb = np.stack([np.interp(height, levels, np.array(palette)[:, c]) for c in range(3)], axis=2)
    rgb += (shade * 70)[:, :, None]
    depth = np.clip(-height / 300, 0, 1)
    water = height <= 0
    rgb[water] = np.stack([171 - 28 * depth, 207 - 21 * depth, 219 - 12 * depth], axis=2)[water]
    dest = ROOT / "data" / "terrain-shading.webp"
    Image.fromarray(np.uint8(np.clip(rgb, 0, 255))).save(dest, quality=88, method=6)
    print(dest, dest.stat().st_size)


if __name__ == "__main__":
    main()


