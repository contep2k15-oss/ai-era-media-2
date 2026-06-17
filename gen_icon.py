#!/usr/bin/env python3
"""Generate app icons for Electron build"""
import struct, zlib, os

def make_png(size, color=(16, 185, 129)):
    """Create a simple colored PNG icon"""
    w = h = size
    raw = b''
    for y in range(h):
        raw += b'\x00'  # filter type
        for x in range(w):
            # Draw rounded square with gradient feel
            cx, cy = x - w/2, y - h/2
            r = min(w, h) * 0.42
            rr = min(w, h) * 0.38
            dist = (cx**2 + cy**2)**0.5
            # Star shape center
            if dist < rr * 0.5:
                raw += bytes([255, 255, 255, 230])
            elif dist < r:
                t = 1 - dist/r
                c = [int(color[i] + (255-color[i]) * t * 0.3) for i in range(3)]
                raw += bytes(c + [255])
            else:
                raw += b'\x00\x00\x00\x00'

    def chunk(name, data):
        c = zlib.crc32(name + data) & 0xffffffff
        return struct.pack('>I', len(data)) + name + data + struct.pack('>I', c)

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)  # 8-bit RGB... use RGBA
    ihdr = struct.pack('>II', w, h) + bytes([8, 6, 0, 0, 0])  # RGBA

    compressed = zlib.compress(raw)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', ihdr)
    png += chunk(b'IDAT', compressed)
    png += chunk(b'IEND', b'')
    return png

os.makedirs('assets', exist_ok=True)
# 256x256 PNG
with open('assets/icon.png', 'wb') as f:
    f.write(make_png(256))
print("icon.png created")
