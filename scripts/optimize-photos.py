#!/usr/bin/env python3
"""
Turn full-resolution phone originals in photos-src/ into web assets in public/photos/.

Originals stay out of git (photos-src is gitignored) — this rebuilds the published
set from them at any time. Re-run after dropping new files in and adding them to
MANIFEST below.

Images: EXIF rotation baked in, long edge capped, re-encoded as progressive JPEG with
ALL metadata stripped (that includes the GPS coordinates every iPhone photo carries).
Videos: H.264 MP4, audio removed, faststart so they begin playing before fully loaded.

    python3 scripts/optimize-photos.py
"""

import os
import shutil
import subprocess
import sys

from PIL import Image, ImageOps

SRC = 'photos-src'
OUT = 'public/photos'

MAX_EDGE = 1600      # long edge, px
JPEG_QUALITY = 80
VIDEO_MAX_W = 1280
VIDEO_CRF = 28

# original filename -> published filename, grouped by trip id in src/data.js
MANIFEST = [
    ('Tuscany.JPG',                                  'tuscany-1.jpg'),
    ('rome.jpeg',                                    'rome-1.jpg'),
    ('Pompeii and naples.jpeg',                      'pompeii-1.jpg'),
    ('Milan.jpeg',                                   'milan-1.jpg'),
    ('Milan movie.mov',                              'milan-2.mp4'),
    ('Switz.jpeg',                                   'switzerland-1.jpg'),
    ('Paris.jpeg',                                   'paris-1.jpg'),
    ('Paris2.jpeg',                                  'paris-2.jpg'),
    ('london.jpeg',                                  'london-1.jpg'),
    ('london2.jpeg',                                 'london-2.jpg'),
    ('Bologna.jpeg',                                 'bologna-1.jpg'),
    ('springbreak and florence.jpeg',                'springbreak-1.jpg'),
    ('springbreak and venice.JPG',                   'springbreak-2.jpg'),
    ('springbreak and rome.jpeg',                    'springbreak-3.jpg'),
    ('Prague castle.jpeg',                           'prague-1.jpg'),
    ('prague john lennon memorial.jpeg',             'prague-2.jpg'),
    ('prague beer spa.jpeg',                         'prague-3.jpg'),
    ('Amsterdam.jpeg',                               'amsterdam-1.jpg'),
    ('amsterdam gunna concert.jpeg',                 'amsterdam-2.jpg'),
    ('Amsterdam heineken tour.jpeg',                 'amsterdam-3.jpg'),
    ('florence timeout.jpeg',                        'timeout-1.jpg'),
    ('castiglioncello.jpeg',                         'pisa-1.jpg'),
    ('pisa.jpeg',                                    'pisa-2.jpg'),
    ('family weekend vatican.jpeg',                  'family-1.jpg'),
    ('family weekend pasta making.JPG',              'family-2.jpg'),
    ('family weekend piazza de michaelangelo.jpeg',  'family-3.jpg'),
    ('morocco1.jpeg',                                'morocco-1.jpg'),
    ('morocco2.jpeg',                                'morocco-2.jpg'),
    ('morocco3.jpeg',                                'morocco-3.jpg'),
    ('morocco4.jpeg',                                'morocco-4.jpg'),
    ('morocco5.JPG',                                 'morocco-5.jpg'),
    ('morocco6.jpeg',                                'morocco-6.jpg'),
    ('malta.jpeg',                                   'malta-1.jpg'),
    ('malta1.JPG',                                   'malta-2.jpg'),
    ('malta2.jpeg',                                  'malta-3.jpg'),
    ('malta3.jpeg',                                  'malta-4.jpg'),
    ('malta4.jpeg',                                  'malta-5.jpg'),
    ('amalficoast.JPG',                              'amalfi-1.jpg'),
    ('amalficoast1.jpeg',                            'amalfi-2.jpg'),
    ('amalficoast2.jpeg',                            'amalfi-3.jpg'),
    ('amalficoastvideo.MOV',                         'amalfi-4.mp4'),
]


def convert_image(src, dst):
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)       # bake EXIF rotation into the pixels
        im = im.convert('RGB')
        im.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
        # no exif= argument -> all metadata (incl. GPS) is dropped
        im.save(dst, 'JPEG', quality=JPEG_QUALITY, optimize=True, progressive=True)
        return im.size


def convert_video(src, dst):
    subprocess.run([
        'ffmpeg', '-y', '-loglevel', 'error', '-i', src,
        '-vf', f"scale='min({VIDEO_MAX_W},iw)':-2",
        '-c:v', 'libx264', '-crf', str(VIDEO_CRF), '-preset', 'slow',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        '-an', dst,
    ], check=True)
    with subprocess.Popen(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', dst],
        stdout=subprocess.PIPE, text=True,
    ) as p:
        return p.stdout.read().strip()


def main():
    if not os.path.isdir(SRC):
        sys.exit(f"missing {SRC}/ — originals should live there (gitignored)")
    if shutil.which('ffmpeg') is None:
        sys.exit('ffmpeg not found — needed for the two video clips')
    os.makedirs(OUT, exist_ok=True)

    missing, total_in, total_out = [], 0, 0
    for src_name, out_name in MANIFEST:
        src = os.path.join(SRC, src_name)
        dst = os.path.join(OUT, out_name)
        if not os.path.exists(src):
            missing.append(src_name)
            continue

        before = os.path.getsize(src)
        dims = convert_video(src, dst) if out_name.endswith('.mp4') else convert_image(src, dst)
        after = os.path.getsize(dst)
        total_in += before
        total_out += after
        print(f"{out_name:<20} {dims!s:<14} {before/1e6:6.1f}MB -> {after/1e6:5.2f}MB")

    print(f"\n{len(MANIFEST) - len(missing)} files: "
          f"{total_in/1e6:.0f}MB -> {total_out/1e6:.1f}MB")
    if missing:
        print(f"\nMISSING from {SRC}/: " + ', '.join(missing))
        sys.exit(1)


if __name__ == '__main__':
    main()
