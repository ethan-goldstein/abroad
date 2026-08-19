# Published photos

**Don't edit this folder by hand.** Everything here is generated from the
full-resolution originals in `photos-src/` (gitignored, never committed) by:

```
python3 scripts/optimize-photos.py
```

That step bakes in EXIF rotation, caps the long edge at 1600px, re-encodes as
progressive JPEG, and **strips all metadata — including the GPS coordinates every
iPhone photo carries**. Videos become muted H.264 MP4. Current batch: 145MB → 15MB.

## Adding photos

1. Drop the originals into `photos-src/` (any filename, any orientation).
2. Add a `('original name.jpeg', 'tripid-N.jpg')` row to `MANIFEST` in
   `scripts/optimize-photos.py`.
3. Run the script.
4. Add the new filename to that trip's `media` array in `src/data.js`.

## Naming

`<tripId>-<n>.jpg`, matching the trip `id` in `src/data.js` — `prague-1.jpg`,
`morocco-4.jpg`. Videos use `.mp4` and are declared as
`{ src: 'amalfi-4.mp4', type: 'video' }`.

## Current coverage

| Trip | Items |
| --- | --- |
| florence | **none — shows the placeholder** |
| tuscany, rome, pompeii, switzerland, bologna, timeout | 1 each |
| milan | 1 + video |
| paris, london, pisa | 2 each |
| springbreak, prague, amsterdam, family | 3 each |
| amalfi | 3 + video |
| malta | 5 |
| morocco | 6 |

41 items total. Trips with one item render without arrows or dots; an empty
`media` array falls back to the styled placeholder.

## Framing

Frames are **4:5 upright**, because 37 of 39 photos are vertical phone shots.
Landscape images are detected on load and shown whole (`contain`) over a blurred
copy of themselves rather than being cropped. To nudge a crop, add `focus` to that
trip in `src/data.js`:

```js
focus: 'center 30%',   // any CSS object-position value
```
