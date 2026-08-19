#!/usr/bin/env python3
"""
Bake a city boundary outline for each trip pin into public/earth/detail/.

Gives the camera something to arrive at other than a flat map: the boundary
traces itself on approach, then the ground outside it dims.

Data: OpenStreetMap via Nominatim, under ODbL — the site must carry
"(c) OpenStreetMap contributors" wherever an outline is shown. This is the
*data* API, which permits this; OSM's separate tile policy forbids basemap tile
streaming and is not used here. Policy caps 1 request/second with a real
User-Agent, so responses are cached and only fetched once.

Several trips are regions rather than cities ("Swiss Alps", the Sahara), so
QUERIES maps each to the town its pin actually sits on. Anything that comes back
as a bare Point, or whose bbox dwarfs the imagery patch (querying Switzerland
returns the whole country), is REJECTED rather than approximated — a made-up
city limit drawn as though it were real is worse than no outline at all. Those
trips fall back to a reticle in the globe code.

    python3 scripts/fetch-city-outlines.py
"""

import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

OUT_DIR = 'public/earth/detail'
CACHE = 'photos-src/.nominatim'
UA = 'ABROAD-trip-tracker/1.0 (ethancgoldstein@gmail.com)'
ENDPOINT = 'https://nominatim.openstreetmap.org/search'
MAX_POINTS = 420          # plenty for a smooth line; Prague raw is 3637
BBOX_SLACK = 2.2          # reject boundaries much larger than the imagery crop

# trip id -> what to actually ask Nominatim for
QUERIES = {
    'florence':    'Firenze, Italy',
    'tuscany':     'Greve in Chianti, Italy',
    'rome':        'Municipio Roma I, Roma, Italy',
    'pompeii':     'Pompei, Italy',
    'milan':       'Milano, Italy',
    'switzerland': 'Lauterbrunnen, Switzerland',
    'paris':       'Paris, France',
    'london':      'City of Westminster, London',
    'bologna':     'Bologna, Italy',
    'springbreak': 'Fiesole, Italy',
    'prague':      'Praha, Czechia',
    'amsterdam':   'Amsterdam, Netherlands',
    'timeout':     'Firenze, Italy',
    'pisa':        'Pisa, Italy',
    'family':      'Municipio Roma I, Roma, Italy',
    'morocco':     'Merzouga, Morocco',
    'malta':       'Valletta, Malta',
    'amalfi':      'Amalfi, Italy',
}


def nominatim(query):
    key = ''.join(c if c.isalnum() else '_' for c in query) + '.json'
    path = os.path.join(CACHE, key)
    if os.path.exists(path):
        return json.load(open(path))
    qs = urllib.parse.urlencode({
        'q': query, 'format': 'json', 'polygon_geojson': 1, 'limit': 1,
    })
    req = urllib.request.Request(f'{ENDPOINT}?{qs}', headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    os.makedirs(CACHE, exist_ok=True)
    json.dump(data, open(path, 'w'))
    time.sleep(1.2)                      # Nominatim allows 1 req/sec
    return data


def rings_from_geojson(geo):
    """Return every outer ring as a list of (lon, lat)."""
    t, c = geo.get('type'), geo.get('coordinates')
    if t == 'Polygon':
        return [c[0]]
    if t == 'MultiPolygon':
        return [poly[0] for poly in c]
    return []                            # Point / LineString -> no boundary


def decimate(ring, limit=MAX_POINTS):
    if len(ring) <= limit:
        return ring
    step = len(ring) / limit
    return [ring[int(i * step)] for i in range(limit)]


def main():
    idx_path = os.path.join(OUT_DIR, 'index.json')
    if not os.path.exists(idx_path):
        sys.exit('run scripts/fetch-pin-imagery.py first — index.json missing')
    patches = {p['id']: p for p in json.load(open(idx_path))['patches']}

    out, kept, rejected = [], 0, []
    for tid, patch in patches.items():
        query = QUERIES.get(tid)
        entry = {'id': tid, 'hasOutline': False, 'rings': [], 'query': query}
        if query:
            try:
                res = nominatim(query)
            except Exception as e:
                res = []
                print(f'  {tid:<12} lookup failed: {e}')
            if res:
                rings = rings_from_geojson(res[0].get('geojson', {}))
                if not rings:
                    rejected.append((tid, 'point only, no boundary'))
                else:
                    lons = [p[0] for r in rings for p in r]
                    lats = [p[1] for r in rings for p in r]
                    w = max(lons) - min(lons)
                    h = max(lats) - min(lats)
                    # imagery is now sized per-city to fit the boundary, so the
                    # only hard reject is "there is no boundary at all"
                    if w > 1.2 or h > 1.2:
                        rejected.append((tid, f'bbox {w:.2f}x{h:.2f} deg — region, not a city'))
                    else:
                        entry['rings'] = [
                            [[round(x, 5), round(y, 5)] for x, y in decimate(r)]
                            for r in rings
                        ]
                        entry['bbox'] = [round(min(lons),5), round(min(lats),5),
                                         round(max(lons),5), round(max(lats),5)]
                        entry['hasOutline'] = True
                        kept += 1
            elif query:
                rejected.append((tid, 'no result'))
        out.append(entry)
        if entry['hasOutline']:
            n = sum(len(r) for r in entry['rings'])
            print(f'  {tid:<12} {n:>4} pts   {query}')

    with open(os.path.join(OUT_DIR, 'outlines.json'), 'w') as f:
        json.dump({
            'attribution': '(c) OpenStreetMap contributors',
            'outlines': out,
        }, f)

    print(f'\n{kept}/{len(patches)} trips have a real boundary')
    if rejected:
        print('reticle fallback (no boundary drawn):')
        for tid, why in rejected:
            print(f'  {tid:<12} {why}')
    print(f"\nsize: {os.path.getsize(os.path.join(OUT_DIR,'outlines.json'))/1000:.0f}KB")


if __name__ == '__main__':
    main()
