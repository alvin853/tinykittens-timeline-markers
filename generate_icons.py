"""
Generates icon16.png / icon48.png / icon128.png reusing the same cat-face
design (ears, face, eyes, nose) as the marker bubbles in content-script.js,
so the toolbar icon visually matches what people see on the progress bar.
Run once with: python3 generate_icons.py
"""

from PIL import Image, ImageDraw

FILL = (255, 183, 3, 255)      # #ffb703
STROKE = (122, 74, 0, 255)     # #7a4a00
DARK = (58, 33, 0, 255)        # #3a2100

SIZES = [16, 48, 128]


def draw_cat_face(size):
    # Draw at 4x and downsample for clean anti-aliased edges at small sizes.
    scale = 4
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    unit = s / 20.0  # original design was authored on a 20x20 viewBox
    stroke_w = max(1, round(unit * 0.6))

    def pt(x, y):
        return (x * unit, y * unit)

    # Ears
    draw.polygon([pt(3, 8), pt(6, 0), pt(8, 8)], fill=FILL, outline=STROKE, width=stroke_w)
    draw.polygon([pt(17, 8), pt(14, 0), pt(12, 8)], fill=FILL, outline=STROKE, width=stroke_w)

    # Face
    face_r = 7 * unit
    face_c = (10 * unit, 12 * unit)
    draw.ellipse(
        [face_c[0] - face_r, face_c[1] - face_r, face_c[0] + face_r, face_c[1] + face_r],
        fill=FILL,
        outline=STROKE,
        width=stroke_w,
    )

    # Eyes
    eye_r = 1 * unit
    for ex in (7.3, 12.7):
        ey = 11 * unit
        draw.ellipse([ex * unit - eye_r, ey - eye_r, ex * unit + eye_r, ey + eye_r], fill=DARK)

    # Nose
    draw.polygon([pt(9, 13.3), pt(11, 13.3), pt(10, 14.6)], fill=DARK)

    return img.resize((size, size), Image.LANCZOS)


for size in SIZES:
    icon = draw_cat_face(size)
    icon.save(f"icons/icon{size}.png")
    print(f"wrote icons/icon{size}.png")
