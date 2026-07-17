# PNG Icon Generator using only Python Standard Library
# Creates beautiful PWA app icons for JKBMS Pro Mobil

import struct
import zlib
import os

def create_png(filename, width, height, draw_func):
    # PNG signature
    header = b'\x89PNG\r\n\x1a\n'
    
    def chunk(chunk_type, data):
        length = struct.pack('>I', len(data))
        crc = struct.pack('>I', zlib.crc32(chunk_type + data) & 0xffffffff)
        return length + chunk_type + data + crc

    # IHDR: Width, Height, Bit depth (8), Color type (2=RGB), Compression (0), Filter (0), Interlace (0)
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    ihdr = chunk(b'IHDR', ihdr_data)
    
    # IDAT: Scanlines with filter 0 prepended
    raw_data = bytearray()
    for y in range(height):
        raw_data.append(0)  # Filter type 0 (None)
        for x in range(width):
            r, g, b = draw_func(x, y, width, height)
            raw_data.append(r)
            raw_data.append(g)
            raw_data.append(b)
            
    compressed_data = zlib.compress(raw_data)
    idat = chunk(b'IDAT', compressed_data)
    
    # IEND
    iend = chunk(b'IEND', b'')
    
    with open(filename, 'wb') as f:
        f.write(header + ihdr + idat + iend)

def draw_battery_icon(x, y, w, h):
    # Scale coordinates to a standard 100x100 space for easier drawing
    nx = (x / w) * 100
    ny = (y / h) * 100
    
    # Theme colors
    bg_r, bg_g, bg_b = 11, 14, 20      # #0b0e14 (deep dark gray/blue)
    neon_r, neon_g, neon_b = 0, 229, 255 # #00e5ff (neon cyan)
    
    # Draw battery border
    # Main box boundaries in 100x100 space
    left, right = 30, 70
    top, bottom = 25, 75
    
    # Check if we are drawing the battery tip (nipple) on top
    is_tip = (top - 5 <= ny < top) and (45 <= nx <= 55)
    
    # Check if we are drawing the battery outer border outline (thickness of 3% in normalized space)
    thickness = 3
    is_border = False
    
    if (left <= nx <= right) and (top <= ny <= bottom):
        # We are inside the main battery box bounds
        on_horizontal_edge = (ny < top + thickness) or (ny > bottom - thickness)
        on_vertical_edge = (nx < left + thickness) or (nx > right - thickness)
        if on_horizontal_edge or on_vertical_edge:
            is_border = True
            
    if is_tip or is_border:
        return neon_r, neon_g, neon_b
        
    # Draw battery charge stripes inside
    # Stripe 1: Bottom charge block
    stripe1 = (bottom - 12 <= ny <= bottom - 6) and (left + 6 <= nx <= right - 6)
    # Stripe 2: Middle charge block
    stripe2 = (bottom - 24 <= ny <= bottom - 18) and (left + 6 <= nx <= right - 6)
    # Stripe 3: Top charge block
    stripe3 = (bottom - 36 <= ny <= bottom - 30) and (left + 6 <= nx <= right - 6)
    # Stripe 4: Highest charge block
    stripe4 = (bottom - 48 <= ny <= bottom - 42) and (left + 6 <= nx <= right - 6)
    
    if stripe1 or stripe2 or stripe3 or stripe4:
        return neon_r, neon_g, neon_b
        
    # Default background
    return bg_r, bg_g, bg_b

if __name__ == "__main__":
    # Generate both PWA icons inside the current folder
    print("Generating icon-192.png...")
    create_png("icon-192.png", 192, 192, draw_battery_icon)
    
    print("Generating icon-512.png...")
    create_png("icon-512.png", 512, 512, draw_battery_icon)
    print("Icons successfully created!")
