#!/usr/bin/env python3
"""
Bake a Sentinel-2 satellite crop for each trip pin into public/earth/detail/.

The globe wears one 4096x2048 Blue Marble texture — about 9.8 km/px — so flying
close just magnifies blur. These crops are ~14 m/px, roughly 700x sharper, and
let the camera actually descend into each destination.

Imagery: EOX Sentinel-2 cloudless (https://cloudless.eox.at), CC BY-NC-SA 4.0.
The site MUST carry the attribution string in ATTRIBUTION below wherever the
imagery is visible. Non-commercial only — a paid EOX license is required if the
site is ever monetized.

    python3 scripts/fetch-pin-imagery.py

Tiles are cached in photos-src/.tilecache (gitignored), so re-runs are free and
the free service only gets hit once.
"""

import io
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.request

from PIL import Image, ImageEnhance, ImageFilter

ZOOM = 13           # default; per-city zoom is chosen to fit the boundary
MIN_ZOOM, MAX_ZOOM = 12, 14   # below z12 the ground detail stops being worth showing   # past z14 Sentinel-2 is upsampled, no real detail
BOUNDARY_FILL = 0.72          # boundary should span this much of the crop
OUT_PX = 1280       # ~18 km across
TILE = 256
QUALITY = 78
LAYER = 's2cloudless-2024_3857'
URL = 'https://tiles.maps.eox.at/wmts/1.0.0/{layer}/default/g/{z}/{y}/{x}.jpg'
ATTRIBUTION = ('Sentinel-2 cloudless by EOX IT Services GmbH '
               '(Contains modified Copernicus Sentinel data 2024)')

OUT_DIR = 'public/earth/detail'
CACHE = 'photos-src/.tilecache'
DATA = 'src/data.js'
UA = 'ABROAD-trip-tracker/1.0 (+https://ethan-goldstein.github.io/abroad/)'


def trips_from_data_js():
    """Pull id/lat/lon straight out of data.js so this can't drift from the site."""
    src = open(DATA, encoding='utf-8').read()
    out = []
    for m in re.finditer(
        r"id: '([a-z]+)',.*?lat: (-?[\d.]+),\s*\n\s*lon: (-?[\d.]+),",
        src, re.S,
    ):
        out.append((m.group(1), float(m.group(2)), float(m.group(3))))
    return out


def lonlat_to_world_px(lon, lat, z):
    n = TILE * (2 ** z)
    x = (lon + 180.0) / 360.0 * n
    s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


def world_px_to_lonlat(x, y, z):
    n = TILE * (2 ** z)
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


def fetch_tile(z, x, y):
    span = 2 ** z
    x %= span                               # wrap the antimeridian
    if not (0 <= y < span):
        return None
    path = os.path.join(CACHE, f'{LAYER}-{z}-{x}-{y}.jpg')
    if os.path.exists(path):
        return Image.open(path).convert('RGB')
    url = URL.format(layer=LAYER, z=z, x=x, y=y)
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                blob = r.read()
            break
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            # ConnectionResetError shows up here too — a free service will drop
            # connections if you push it, so back off rather than give up
            if attempt == 3:
                print(f'    tile {z}/{x}/{y} failed: {e}')
                return None
            time.sleep(2.0 * (attempt + 1))
    else:
        return None
    time.sleep(0.12)                          # pace requests between fetches
    os.makedirs(CACHE, exist_ok=True)
    with open(path, 'wb') as f:
        f.write(blob)
    return Image.open(io.BytesIO(blob)).convert('RGB')


def zoom_for(bbox):
    """Pick the tightest zoom where the boundary still fits the crop.

    One fixed zoom made Prague's outline spill off its own imagery while
    Valletta's sat as a speck in the middle — the crop has to match the city.
    """
    if not bbox:
        return ZOOM
    w = max(bbox[2] - bbox[0], 1e-4)
    h = max(bbox[3] - bbox[1], 1e-4)
    best = MIN_ZOOM
    for z in range(MIN_ZOOM, MAX_ZOOM + 1):
        span_lon = OUT_PX / (TILE * (2 ** z)) * 360.0
        # crop is square in pixels, so its latitude span is narrower by cos(lat)
        mid = math.radians((bbox[1] + bbox[3]) / 2)
        span_lat = span_lon * math.cos(mid)
        if w <= span_lon * BOUNDARY_FILL and h <= span_lat * BOUNDARY_FILL:
            best = z
    return best


def bake(trip_id, lat, lon, zoom=ZOOM):
    global ZOOM_USED
    ZOOM_USED = zoom
    cx, cy = lonlat_to_world_px(lon, lat, zoom)
    left, top = cx - OUT_PX / 2, cy - OUT_PX / 2
    tx0, ty0 = math.floor(left / TILE), math.floor(top / TILE)
    tx1 = math.floor((left + OUT_PX - 1) / TILE)
    ty1 = math.floor((top + OUT_PX - 1) / TILE)

    canvas = Image.new('RGB', ((tx1 - tx0 + 1) * TILE, (ty1 - ty0 + 1) * TILE), (8, 14, 28))
    got = 0
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            t = fetch_tile(zoom, tx, ty)
            if t is not None:
                canvas.paste(t, ((tx - tx0) * TILE, (ty - ty0) * TILE))
                got += 1

    ox, oy = int(round(left - tx0 * TILE)), int(round(top - ty0 * TILE))
    crop = canvas.crop((ox, oy, ox + OUT_PX, oy + OUT_PX))
    # Sentinel-2 is hazy and blue-grey out of the box, and it is being viewed on a
    # dark page — without a grade the terrain reads as mud.
    crop = ImageEnhance.Brightness(crop).enhance(1.18)
    crop = ImageEnhance.Contrast(crop).enhance(1.42)
    crop = ImageEnhance.Color(crop).enhance(1.30)
    crop = crop.filter(ImageFilter.UnsharpMask(radius=1.6, percent=60, threshold=3))

    os.makedirs(OUT_DIR, exist_ok=True)
    dst = os.path.join(OUT_DIR, f'{trip_id}.jpg')
    crop.save(dst, 'JPEG', quality=QUALITY, optimize=True, progressive=True)

    # exact footprint so the globe can size its patch to match the pixels
    lon_w, lat_n = world_px_to_lonlat(left, top, zoom)
    lon_e, lat_s = world_px_to_lonlat(left + OUT_PX, top + OUT_PX, zoom)
    m_per_px = 156543.03392 / (2 ** zoom) * math.cos(math.radians(lat))
    return {
        'id': trip_id,
        'lat': lat, 'lon': lon,
        'north': lat_n, 'south': lat_s, 'west': lon_w, 'east': lon_e,
        'zoom': zoom,
        'mPerPx': round(m_per_px, 2),
        'widthKm': round(OUT_PX * m_per_px / 1000, 1),
        'bytes': os.path.getsize(dst),
        'tiles': got,
    }


def main():
    if not os.path.exists(DATA):
        sys.exit(f'run from the repo root — {DATA} not found')
    trips = trips_from_data_js()
    if not trips:
        sys.exit('parsed no trips out of data.js')
    print(f'{len(trips)} pins, z{ZOOM}, {OUT_PX}px crops\n')

    bboxes = {}
    op = os.path.join(OUT_DIR, 'outlines.json')
    if os.path.exists(op):
        for o in json.load(open(op))['outlines']:
            if o.get('bbox'):
                bboxes[o['id']] = o['bbox']

    meta, total = [], 0
    for tid, lat, lon in trips:
        bb = bboxes.get(tid)
        # centre the crop on the boundary, not the pin — the pin sits wherever the
        # trip happened, which can push a large city off the edge of its own frame
        clon, clat = lon, lat
        if bb:
            blon, blat = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
            # Only nudge if the boundary sits essentially under the pin. The camera
            # flies to the PIN, so recentring on a distant centroid (the Swiss Alps
            # pin is ~40 km from Lauterbrunnen) puts the imagery off-screen entirely.
            if abs(blon - lon) < 0.05 and abs(blat - lat) < 0.05:
                clon, clat = blon, blat
        info = bake(tid, clat, clon, zoom_for(bb))
        meta.append(info)
        total += info['bytes']
        print(f"  {tid:<12} z{info['zoom']:<2} {info['widthKm']:>5.1f}km  {info['mPerPx']:>5.1f}m/px  "
              f"{info['tiles']:>2} tiles  {info['bytes']/1000:>6.0f}KB")

    with open(os.path.join(OUT_DIR, 'index.json'), 'w') as f:
        json.dump({'attribution': ATTRIBUTION,
                   'size': OUT_PX, 'patches': meta}, f, indent=2)

    # A boundary that still doesn't fit at the floor zoom (Pisa's comune is 0.76
    # deg across) cannot be drawn honestly over this crop — demote it to the
    # reticle rather than stranding a line off the edge of its own imagery.
    if os.path.exists(op):
        data = json.load(open(op))
        by_id = {m['id']: m for m in meta}
        demoted = []
        for o in data['outlines']:
            m = by_id.get(o['id'])
            if not (o.get('hasOutline') and m and o.get('bbox')):
                continue
            bb = o['bbox']
            if (bb[0] < m['west'] or bb[2] > m['east']
                    or bb[1] < m['south'] or bb[3] > m['north']):
                o['hasOutline'] = False
                o['rings'] = []
                demoted.append(o['id'])
        if demoted:
            json.dump(data, open(op, 'w'))
            print('outline overflows its crop, reticle instead: ' + ', '.join(demoted))

    print(f'\n{len(meta)} crops, {total/1e6:.1f}MB total')
    print(f'attribution required on-site:\n  {ATTRIBUTION}')


if __name__ == '__main__':
    main()
