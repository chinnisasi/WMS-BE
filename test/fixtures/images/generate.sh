#!/usr/bin/env bash
# Regenerates the image-sanitizer fixtures (test/image-sanitize.spec.ts).
# Encoders: libjpeg-turbo cjpeg (>= 3.0, for -lossless), libwebp cwebp /
# webpmux / img2webp, macOS sips. The python step only writes raw pixel
# sources and splices real metadata segments into encoder output — every
# PNG/JPEG structure it writes carries genuine CRCs and lengths.
# Usage: test/fixtures/images/generate.sh   (writes next to this script)
set -euo pipefail
OUT="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
ICC="/System/Library/ColorSync/Profiles/Display P3.icc"

python3 -I - "$WORK" "$ICC" <<'PY'
import struct, sys, zlib, os
work, icc_path = sys.argv[1], sys.argv[2]
os.chdir(work)

def ppm(name, w, h, gray=False):
    if gray:
        px = bytes(((x * 7 + y * 3) % 256) for y in range(h) for x in range(w))
        open(name, 'wb').write(b'P5\n%d %d\n255\n' % (w, h) + px)
    else:
        px = bytes((((x * 10) % 256) if c == 0 else ((y * 15) % 256) if c == 1 else 128)
                   for y in range(h) for x in range(w) for c in range(3))
        open(name, 'wb').write(b'P6\n%d %d\n255\n' % (w, h) + px)

ppm('rgb.ppm', 24, 16)
ppm('thumb.ppm', 8, 8)
ppm('wide8001.pgm', 8001, 1, gray=True)
ppm('wide8000.pgm', 8000, 1, gray=True)
ppm('frame2.ppm', 24, 16)

def chunk(t, data):
    return struct.pack('>I', len(data)) + t + data + struct.pack('>I', zlib.crc32(t + data) & 0xffffffff)

def png(w, h, color_type, rows, extra_after_ihdr=b'', extra_before_iend=b''):
    ihdr = struct.pack('>IIBBBBB', w, h, 8, color_type, 0, 0, 0)
    raw = b''.join(b'\x00' + r for r in rows)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + extra_after_ihdr +
            chunk(b'IDAT', zlib.compress(raw, 9)) + extra_before_iend + chunk(b'IEND', b''))

rgba_rows = [bytes(v for x in range(24) for v in ((x * 10) % 256, (y * 15) % 256, 128, (x * 11) % 256)) for y in range(16)]
open('rgba.png', 'wb').write(png(24, 16, 6, rgba_rows))
rgb_rows = [bytes(v for x in range(24) for v in ((x * 10) % 256, (y * 15) % 256, 128)) for y in range(16)]

def gps_tiff():
    # Big-endian TIFF: IFD0 {Make, GPSInfo} -> GPS IFD {LatRef, Lat, LonRef, Lon}.
    make = b'WMSCam\x00'
    ifd0_off = 8
    ifd0_len = 2 + 2 * 12 + 4
    make_off = ifd0_off + ifd0_len
    gps_off = make_off + len(make) + (len(make) & 1)
    gps_len = 2 + 4 * 12 + 4
    lat_off = gps_off + gps_len
    lon_off = lat_off + 24
    rat = lambda d, m, s: struct.pack('>IIIIII', d, 1, m, 1, s, 100)
    out = b'MM\x00\x2a' + struct.pack('>I', ifd0_off)
    out += struct.pack('>H', 2)
    out += struct.pack('>HHII', 0x010F, 2, len(make), make_off)
    out += struct.pack('>HHII', 0x8825, 4, 1, gps_off)
    out += struct.pack('>I', 0)
    out += make + (b'\x00' if len(make) & 1 else b'')
    out += struct.pack('>H', 4)
    out += struct.pack('>HHI', 0x0001, 2, 2) + b'N\x00\x00\x00'
    out += struct.pack('>HHII', 0x0002, 5, 3, lat_off)
    out += struct.pack('>HHI', 0x0003, 2, 2) + b'E\x00\x00\x00'
    out += struct.pack('>HHII', 0x0004, 5, 3, lon_off)
    out += struct.pack('>I', 0)
    out += rat(17, 23, 4512) + rat(78, 28, 1890)
    return out

tiff = gps_tiff()
open('exif.bin', 'wb').write(b'Exif\x00\x00' + tiff)
xmp = b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></x:xmpmeta>'
open('xmp.xml', 'wb').write(xmp + (b'' if len(xmp) % 2 else b' '))  # odd length: exercises the RIFF pad byte
icc = open(icc_path, 'rb').read()

# PNG with every dropped ancillary text/time/exif chunk, plus kept iCCP and pHYs.
meta = (chunk(b'iCCP', b'Display P3\x00\x00' + zlib.compress(icc)) +
        chunk(b'pHYs', struct.pack('>IIB', 2835, 2835, 1)) +
        chunk(b'tEXt', b'Comment\x00shot at dock 4') +
        chunk(b'zTXt', b'Description\x00\x00' + zlib.compress(b'damaged pallet')) +
        chunk(b'iTXt', b'Author\x00\x00\x00\x00\x00picker 7') +
        chunk(b'tIME', struct.pack('>HBBBBB', 2026, 10, 26, 9, 30, 0)) +
        chunk(b'eXIf', tiff))
open('metadata.png', 'wb').write(png(24, 16, 2, rgb_rows, extra_after_ihdr=meta))

# APNG: acTL + fcTL before the default image, then one fdAT frame.
def fctl(seq):
    return chunk(b'fcTL', struct.pack('>IIIIIHHBB', seq, 24, 16, 0, 0, 1, 10, 0, 0))
frame = zlib.compress(b''.join(b'\x00' + r for r in rgb_rows), 9)
apng = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 24, 16, 8, 2, 0, 0, 0)) +
        chunk(b'acTL', struct.pack('>II', 2, 0)) + fctl(0) + chunk(b'IDAT', frame) +
        fctl(1) + chunk(b'fdAT', struct.pack('>I', 2) + frame) + chunk(b'IEND', b''))
open('animated.png', 'wb').write(apng)

# Unknown critical chunk (Apple's CgBI is the real-world one) right after IHDR.
open('unknown-critical.png', 'wb').write(png(24, 16, 2, rgb_rows, extra_after_ihdr=chunk(b'CgBI', b'\x50\x00\x20\x06')))

wide_rows = [bytes((x * 7) % 256 for x in range(8001))]
open('wide-8001.png', 'wb').write(png(8001, 1, 0, wide_rows))
PY

cjpeg -quality 80 rgb.ppm > "$OUT/baseline.jpg"
cjpeg -quality 80 -restart 1B rgb.ppm > "$OUT/restart.jpg"
cjpeg -quality 80 -progressive rgb.ppm > progressive.jpg
cjpeg -quality 60 thumb.ppm > thumb.jpg
cjpeg -lossless 1 rgb.ppm > "$OUT/lossless-sof3.jpg"
cjpeg -arithmetic rgb.ppm > "$OUT/arithmetic-sof9.jpg"
cjpeg -grayscale wide8001.pgm > "$OUT/wide-8001.jpg"
cjpeg -grayscale wide8000.pgm > "$OUT/wide-8000.jpg"
sips -s format png "$OUT/baseline.jpg" --out "$OUT/sips.png" > /dev/null
sips -s format jpeg --embedProfile "$ICC" "$OUT/sips.png" --out sips-icc.jpg > /dev/null
sips -s format heic "$OUT/sips.png" --out "$OUT/photo.heic" > /dev/null
sips -s format gif "$OUT/sips.png" --out "$OUT/photo.gif" > /dev/null
sips -s format pdf "$OUT/sips.png" --out "$OUT/photo.pdf" > /dev/null
cp metadata.png animated.png unknown-critical.png wide-8001.png "$OUT/"

cwebp -quiet -q 80 rgba.png -o "$OUT/alpha.webp"
cwebp -quiet -q 80 -noalpha rgba.png -o "$OUT/lossy.webp"
cwebp -quiet -lossless rgba.png -o "$OUT/lossless.webp"
cwebp -quiet -q 50 wide8001.pgm -o "$OUT/wide-8001.webp" 2>/dev/null || cwebp -quiet -q 50 "$OUT/wide-8001.png" -o "$OUT/wide-8001.webp"
webpmux -set icc "$ICC" "$OUT/alpha.webp" -o m1.webp
webpmux -set exif exif.bin m1.webp -o m2.webp
webpmux -set xmp xmp.xml m2.webp -o "$OUT/metadata.webp"
img2webp -loop 0 -lossy -d 100 rgba.png -d 100 "$OUT/sips.png" -o "$OUT/animated.webp" > /dev/null

python3 -I - "$WORK" "$OUT" <<'PY'
import struct, sys, os
work, out = sys.argv[1], sys.argv[2]
os.chdir(work)
seg = lambda m, payload: b'\xff' + bytes([m]) + struct.pack('>H', len(payload) + 2) + payload
exif = open('exif.bin', 'rb').read()
app13 = seg(0xED, b'Photoshop 3.0\x00' + b'8BIM\x04\x04\x00\x00' + struct.pack('>I', 12) + b'\x1c\x02\x78\x00\x08dock 4!!')
com = seg(0xFE, b'between-scan comment')

# Progressive: APP13 + COM + APP1 spliced between the first and second scans.
p = open('progressive.jpg', 'rb').read()
first = p.index(b'\xff\xda')
second = p.index(b'\xff\xda', first + 2)
# back up over the DHT that precedes the second scan, if any, so the metadata sits between scans
dht = p.rfind(b'\xff\xc4', first, second)
cut = dht if dht != -1 else second
open(os.path.join(out, 'progressive-app13.jpg'), 'wb').write(p[:cut] + app13 + com + seg(0xE1, exif) + p[cut:])

def after_app0(j):
    assert j[2:4] == b'\xff\xe0'
    return 4 + struct.unpack('>H', j[4:6])[0]

# GPS EXIF + COM in a sips JPEG that carries an embedded ICC profile (APP2).
s = open('sips-icc.jpg', 'rb').read()
assert b'ICC_PROFILE\x00' in s
i = after_app0(s)
open(os.path.join(out, 'gps-exif-icc.jpg'), 'wb').write(s[:i] + seg(0xE1, exif) + seg(0xFE, b'Shot on WMSCam') + s[i:])

b = open(os.path.join(out, 'baseline.jpg'), 'rb').read()
t = open('thumb.jpg', 'rb').read()
i = after_app0(b)
# JFXX extension APP0 with a JPEG-coded thumbnail (extension code 0x10).
open(os.path.join(out, 'jfxx-thumbnail.jpg'), 'wb').write(b[:i] + seg(0xE0, b'JFXX\x00\x10' + t) + b[i:])

# MPF (CIPA DC-007): APP2 "MPF\0" index IFD, and the second image appended after EOI.
mp_ifd = (b'MM\x00\x2a' + struct.pack('>I', 8) + struct.pack('>H', 3) +
          struct.pack('>HHI', 0xB000, 7, 4) + b'0100' +
          struct.pack('>HHII', 0xB001, 4, 1, 2) +
          struct.pack('>HHII', 0xB002, 7, 32, 50) + struct.pack('>I', 0))
entries = struct.pack('>IIIHH', 0x030000, 0, 0, 0, 0) + struct.pack('>IIIHH', 0x010001, len(t), 0, 0, 0)
mpf = seg(0xE2, b'MPF\x00' + mp_ifd + entries)
open(os.path.join(out, 'mpf.jpg'), 'wb').write(b[:i] + mpf + b[i:] + t)
PY
echo "fixtures written to $OUT"
ls -la "$OUT"
