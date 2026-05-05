"""
CyberSense.Solutions – Training Byte Carousel Generator
========================================================
Usage: Edit the CONTENT section below, then run:
    python3 generate_carousel.py

Requirements: pip install Pillow requests
Output: 4 PNG files (1080x1080) ready for Meta carousel post.
"""

from PIL import Image, ImageDraw, ImageFont
import math, os, io, requests

# ══════════════════════════════════════════════════════════════════════════════
# CONTENT – Edit this section for each new carousel
# ══════════════════════════════════════════════════════════════════════════════

EDITION_NUMBER   = "117"
CARD2_TAG        = "Why it matters now"
CARD2_LINE1      = "Local AI Tools"
CARD2_LINE2      = "Update Hijacking"
CARD2_LINE3      = "Subverted Pipeline Trust"
CARD2_BODY1      = "Security researchers have identified a critical supply chain risk in the Windows version of Ollama, a popular tool for running local AI models. The flaw (CVE-2026-42249) allows for the delivery of silent malware through the tool’s automatic update mechanism. By subverting the pipeline trust, cybercriminals can theoretically push malicious code to local machines without user interaction or visual indicators."
CARD2_BODY2      = "Many emerging AI tools utilize background auto-update mechanisms that may lack rigorous cryptographic signature verification. This creates a vulnerability where a threat actor, having compromised an update server or intercepted transit traffic, can push malicious code directly to a local workstation under the guise of a routine security patch."
CARD2_STAT       = "CVSS: 7.7"
CARD2_STAT_LINE1 = "Remote Code Execution via Unsigned Update Mechanism"
CARD2_STAT_LINE2 = "CVE-2026-42249 → Ollama Auto-Updates"

CARD3_TAG    = "What to do now"
CARD3_LINE1  = "3 Controls"
CARD3_LINE2  = "Defending Your"
CARD3_LINE3  = "Local AI Pipeline"
CARD3_STEPS  = [
    ("①", "Disable Passive Updates", "Locate and disable automatic background updates in all local AI tools. Reclaim state control over your environment."),
    ("②", "Enforce Pull-and-Verify", "Transition to manual updates. Always pull installers from official developer channels and verify SHA-256 hashes against published checksums before executing."),
    ("③", "Sandbox Emerging Toolsets", "Isolate untrusted AI packages and their update routines within containers or sandboxed environments to insulate the host OS from potential supply chain contamination.")
]
CARD3_CLOSE  = "Automation is for scale; manual verification is for survival. Never let the speed of your tools outrun the rigor of your defense."

CARD4_HEADLINE = f"Edition {EDITION_NUMBER}"
CARD4_SUBHEAD  = "is live."
CARD4_BULLETS  = [
    "Weaver E-cology Under Fire: Unauthenticated RCE via Debug Endpoint (CVE-2026-22679)",
    "Emergency Chrome Update: Triage for High-Severity Zero-Day (CVE-2026-2441)",
    "Ollama Windows Alert: Silent Malware via Subverted Auto-Updates (CVE-2026-42249)",
    "Hypersonic Supply Chain Defense: Detecting Payloads Without Knowing the Content",
    "Building for the Agentic Workforce: Is Your Enterprise Architecture Ready?"
]
CARD4_URL = "cybersense.solutions/newsletter"

OUTPUT_DIR = "."  # Change to your output folder if needed

# ══════════════════════════════════════════════════════════════════════════════
# Local FONTS – DownloaLoading from /fonts folder
# ══════════════════════════════════════════════════════════════════════════════

def get_font(name, size):
    """Load font from local /fonts folder relative to this script."""
    # This finds the 'tools' folder (or wherever this .py file sits)
    base_path = os.path.dirname(os.path.abspath(__file__))
    font_path = os.path.join(base_path, "fonts", f"{name}.ttf")
    
    if os.path.exists(font_path):
        return ImageFont.truetype(font_path, size)
    else:
        # This will tell you exactly which file is missing in the console
        print(f"--- MISSING FONT: {name}.ttf not found in {font_path} ---")
        return ImageFont.load_default()

def load_fonts():
    print("Loading local fonts...")
    # Ensure these names match your filenames in the /fonts folder exactly
    return {
        'hero':     get_font("BricolageGrotesque-Bold", 72),
        'h1':       get_font("BricolageGrotesque-Bold", 54),
        'h2':       get_font("BricolageGrotesque-Bold", 40),
        'h3':       get_font("WorkSans-Bold", 28),
        'body':     get_font("InstrumentSans-Regular", 24),
        'body_b':   get_font("InstrumentSans-Bold", 24),
        'small':    get_font("InstrumentSans-Regular", 18),
        'mono':     get_font("JetBrainsMono-Regular", 16),
        'label':    get_font("InstrumentSans-Bold", 14),
        'wordmark': get_font("BricolageGrotesque-Bold", 28),
    }

# ══════════════════════════════════════════════════════════════════════════════
# DESIGN SYSTEM – Do not edit unless changing brand
# ══════════════════════════════════════════════════════════════════════════════

NAVY       = (10, 22, 40)
NAVY_DARK  = (6, 14, 28)
NAVY_MID   = (8, 18, 36)
CYAN       = (0, 212, 255)
CYAN_DIM   = (0, 120, 160)
WHITE      = (255, 255, 255)
GRAY_LIGHT = (226, 232, 240)
GRAY_MID   = (148, 163, 184)
AMBER      = (245, 158, 11)

W, H = 1080, 1080

def base_canvas(bg=NAVY):
    img = Image.new("RGB", (W, H), bg)
    draw = ImageDraw.Draw(img)
    for x in range(0, W, 54):
        for y in range(H):
            if (y // 2) % 4 == 0:
                draw.point((x, y), fill=(0, 40, 70))
    for y in range(0, H, 54):
        for x in range(W):
            if (x // 2) % 4 == 0:
                draw.point((x, y), fill=(0, 40, 70))
    return img, draw

def draw_wordmark(draw, fonts):
    t1, t2 = "CyberSense", ".Solutions"
    b1 = draw.textbbox((0,0), t1, font=fonts['wordmark'])
    b2 = draw.textbbox((0,0), t2, font=fonts['wordmark'])
    total = (b1[2]-b1[0]) + (b2[2]-b2[0])
    x = (W - total) // 2
    y = H - 58
    draw.text((x, y), t1, font=fonts['wordmark'], fill=WHITE)
    draw.text((x + (b1[2]-b1[0]), y), t2, font=fonts['wordmark'], fill=CYAN)

def draw_bottom_bar(draw):
    draw.rectangle([0, H-90, W, H], fill=NAVY_DARK)
    draw.rectangle([0, H-90, W, H-88], fill=CYAN_DIM)

def draw_cyan_bar(draw):
    draw.rectangle([0, 0, W, 4], fill=CYAN)

def draw_section_tag(draw, fonts, text, x, y, accent=CYAN):
    bbox = draw.textbbox((0,0), text, font=fonts['label'])
    tw = bbox[2]-bbox[0]
    draw.rounded_rectangle([x, y, x+tw+40, y+36], radius=4, fill=(20, 40, 80))
    draw.rectangle([x, y, x+4, y+36], fill=accent)
    draw.text((x+16, y+11), text, font=fonts['label'], fill=accent)

def wrap_text(draw, text, font, max_width):
    words = text.split()
    lines, current = [], ""
    for word in words:
        test = (current + " " + word).strip()
        bbox = draw.textbbox((0,0), test, font=font)
        if bbox[2]-bbox[0] <= max_width:
            current = test
        else:
            if current: lines.append(current)
            current = word
    if current: lines.append(current)
    return lines

def draw_wrapped(draw, text, font, x, y, max_width, color=WHITE, line_height=None):
    lines = wrap_text(draw, text, font, max_width)
    lh = line_height or (draw.textbbox((0,0), "A", font=font)[3] + 8)
    for line in lines:
        draw.text((x, y), line, font=font, fill=color)
        y += lh
    return y

def make_card1(fonts):
    img, draw = base_canvas()
    draw_cyan_bar(draw)
    cx, cy = W//2, H//2 - 40
    for r in [80,160,240,320,400]:
        for angle in range(0, 360, 2):
            rad = math.radians(angle)
            px = int(cx + r * math.cos(rad))
            py = int(cy + r * math.sin(rad))
            if 0 <= px < W and 0 <= py < H:
                a = max(20, int(80*(1-r/420)))
                draw.point((px,py), fill=(0,a+20,a+80))
    for angle in range(270, 360, 2):
        rad = math.radians(angle)
        for r in range(0, 405):
            px = int(cx + r * math.cos(rad))
            py = int(cy + r * math.sin(rad))
            if 0 <= px < W and 0 <= py < H:
                fade = int(60*(1-abs(angle-315)/45))
                draw.point((px,py), fill=(0,fade+20,fade+100))
    draw.ellipse([cx-6,cy-6,cx+6,cy+6], fill=CYAN)
# --- Centered Tag Logic ---
    tag = f"EDITION {EDITION_NUMBER}"
    font_tag = fonts['label']
    
    # 1. Calculate text width to determine the box size
    bbox = draw.textbbox((0, 0), tag, font=font_tag)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    
    # 2. Define the Box (32px padding on sides, 36px total height)
    rect_w = tw + 32
    rect_h = 36
    rect_x = (W - rect_w) // 2
    rect_y = 200
    
    # 3. Draw the Cyan Background
    draw.rounded_rectangle([rect_x, rect_y, rect_x + rect_w, rect_y + rect_h], radius=4, fill=CYAN)
    
    # 4. Draw the Text using Middle-Middle alignment
    # Center point of the box: (Start + Width/2, Start + Height/2)
    text_center_x = rect_x + (rect_w // 2)
    text_center_y = rect_y + (rect_h // 2)
    
    draw.text((text_center_x, text_center_y), tag, font=font_tag, fill=NAVY, anchor="mm")
    for txt, color, y in [("Daily",WHITE,260),("Training Byte",CYAN,340)]:
        b = draw.textbbox((0,0), txt, font=fonts['hero'])
        draw.text(((W-(b[2]-b[0]))//2, y), txt, font=fonts['hero'], fill=color)

# 1. Keep your line where it is
    line_y = 480 
    draw.rectangle([80, line_y, W-80, line_y + 2], fill=CYAN_DIM)
    
# 2. Centered, larger subtext
    subtext = "One actionable technique. Every weekday. Plain language."
    
# Let's use 'body' font for better readability at this size
    sub_font = fonts['body'] 
    
# Calculate centering
    sub_bbox = draw.textbbox((0, 0), subtext, font=sub_font)
    sub_w = sub_bbox[2] - sub_bbox[0]
    sub_x = (W - sub_w) // 2  # This centers it perfectly
    
    draw.text((sub_x, line_y + 45), subtext, font=sub_font, fill=GRAY_LIGHT)
    
    draw_bottom_bar(draw)
    draw_wordmark(draw, fonts)
    
    # Tagline right-aligned with a 60px margin from the edge
    tagline = "Security awareness starts here."
    t_bbox = draw.textbbox((0, 0), tagline, font=fonts['small'])
    text_width = t_bbox[2] - t_bbox[0]
    
    # Calculation: Screen Width - Text Width - Margin
    tx = W - text_width - 60 
    
    # Keeping H - 125 to stay perfectly level with the bottom bar elements
    draw.text((tx, H - 125), tagline, font=fonts['small'], fill=GRAY_MID)

    return img

def make_card2(fonts):
    img, draw = base_canvas()
    draw_cyan_bar(draw)
    draw_section_tag(draw, fonts, CARD2_TAG, 60, 80)
    
    # 1. Spaced out Headline (y=160 instead of 140)
    draw.text((60, 160), CARD2_LINE1, font=fonts['h1'], fill=WHITE)
    draw.text((60, 225), CARD2_LINE2, font=fonts['h1'], fill=WHITE)
    draw.text((60, 290), CARD2_LINE3, font=fonts['h1'], fill=CYAN)
    
    # 2. Divider Line (y=380)
    draw.rectangle([60, 380, 200, 383], fill=CYAN)
    
    # 3. Body text with more leading (line_height=40)
    # Start body lower at y=410
    y = draw_wrapped(draw, CARD2_BODY1, fonts['body'], 60, 410, W-120, color=GRAY_LIGHT, line_height=40)
    
    # Increase gap between paragraphs (y += 40)
    y += 30 
    y = draw_wrapped(draw, CARD2_BODY2, fonts['body'], 60, y, W-120, color=GRAY_LIGHT, line_height=30)
    
    # 4. Stat Box (Push it further down)
    # --- Refined Stat Box ---
    y += 40 
    box_height = 110  # Slightly taller for better vertical centering
    draw.rounded_rectangle([60, y, W-60, y + box_height], radius=12, fill=(6, 18, 38), outline=CYAN_DIM)
    
    # Increase horizontal padding from 100 to 120
    stat_x = 100 
    # Center items vertically within the box_height
    # (y + box_height/2) is the middle line
    
    # The big number
    draw.text((stat_x, y + 25), CARD2_STAT, font=fonts['h2'], fill=CYAN)
    
    # The description - pushed right more to separate from the %
    desc_x = stat_x + 200
    draw.text((desc_x, y + 32), CARD2_STAT_LINE1, font=fonts['body'], fill=GRAY_MID)
    
    # The date range - aligned under the description
    draw.text((desc_x, y + 65), CARD2_STAT_LINE2, font=fonts['mono'], fill=GRAY_MID)
    
    draw_bottom_bar(draw)
    draw_wordmark(draw, fonts)

    # Tagline right-aligned with a 60px margin from the edge
    tagline = "Security awareness starts here."
    t_bbox = draw.textbbox((0, 0), tagline, font=fonts['small'])
    text_width = t_bbox[2] - t_bbox[0]
    
    # Calculation: Screen Width - Text Width - Margin
    tx = W - text_width - 60 
    
    # Keeping H - 125 to stay perfectly level with the bottom bar elements
    draw.text((tx, H - 125), tagline, font=fonts['small'], fill=GRAY_MID)

    return img

def make_card3(fonts):
    img, draw = base_canvas(NAVY_MID)
    draw_cyan_bar(draw)
    draw_section_tag(draw, fonts, CARD3_TAG, 60, 80, accent=AMBER)
    
    # 1. Spaced out Headline
    draw.text((60, 160), CARD3_LINE1, font=fonts['h1'], fill=WHITE)
    draw.text((60, 225), CARD3_LINE2, font=fonts['h1'], fill=WHITE)
    draw.text((60, 290), CARD3_LINE3, font=fonts['h1'], fill=CYAN)
    
    # 2. Divider Line
    draw.rectangle([60, 370, 180, 373], fill=AMBER)
    
    y = 410  # Start steps lower for better balance
    
    for _, title, desc in CARD3_STEPS:
        # 3. Draw a sharp Checkmark Circle
        circle_size = 44
        draw.ellipse([60, y, 60 + circle_size, y + circle_size], fill=CYAN)
        
        # Draw a custom checkmark (V-shape) inside the circle
        # Coordinates relative to the circle
        check_color = NAVY
        draw.line([72, y+22, 80, y+30], fill=check_color, width=4)
        draw.line([80, y+30, 92, y+14], fill=check_color, width=4)
        
        # 4. Step Text - Larger title and more horizontal padding
        text_x = 120 
        draw.text((text_x, y + 2), title, font=fonts['h3'], fill=WHITE) # Switched to h3 for size
        
        # Description with more leading
        draw_wrapped(draw, desc, fonts['body'], text_x, y + 40, W-180, color=GRAY_MID, line_height=25) # Decrease line height for longer descriptions
        
        y += 125  # Increased spacing between steps (from 100 to 125)
    
    # 5. Footer Line and Closing Text
    draw.rectangle([60, y + 10, W-60, y + 12], fill=CYAN_DIM)
    draw_wrapped(draw, CARD3_CLOSE, fonts['body'], 60, y + 35, W-120, color=CYAN, line_height=42)
    
    draw_bottom_bar(draw)
    draw_wordmark(draw, fonts)

    # Tagline right-aligned with a 60px margin from the edge
    tagline = "Security awareness starts here."
    t_bbox = draw.textbbox((0, 0), tagline, font=fonts['small'])
    text_width = t_bbox[2] - t_bbox[0]
    
    # Calculation: Screen Width - Text Width - Margin
    tx = W - text_width - 60 
    
    # Keeping H - 125 to stay perfectly level with the bottom bar elements
    draw.text((tx, H - 125), tagline, font=fonts['small'], fill=GRAY_MID)

    return img

def make_card4(fonts):
    img, draw = base_canvas()
    draw_cyan_bar(draw)
    
    # Keep the background concentric circles
    for r in range(300, 0, -10):
        a = int(12*(1-r/300))
        draw.ellipse([W//2-r, H//2-r-100, W//2+r, H//2+r-100], outline=(0,a*3,a*8))
    
    draw_section_tag(draw, fonts, "WANT THE FULL BRIEF?", 60, 80)
    
    # 1. Spaced out Headline
    draw.text((60, 160), CARD4_HEADLINE, font=fonts['h1'], fill=CYAN)
    draw.text((60, 225), CARD4_SUBHEAD,  font=fonts['h1'], fill=WHITE)
    draw.rectangle([60, 305, 160, 308], fill=CYAN)
    
    y = 350 # Pushing bullets down for breathing room
    
    for item in CARD4_BULLETS:
        # 2. Draw Checkmark Bullets (consistent with Card 3)
        circle_size = 28
        draw.ellipse([60, y + 4, 60 + circle_size, y + 4 + circle_size], fill=CYAN)
        # Smaller checkmark for the smaller circles
        draw.line([68, y+18, 73, y+23], fill=NAVY, width=3)
        draw.line([73, y+23, 82, y+14], fill=NAVY, width=3)
        
        # 3. Item text with more room
        draw_wrapped(draw, item, fonts['body'], 105, y, W-160, color=GRAY_LIGHT, line_height=34)
        y += 90 # Increased space between bullet points
    
    # 4. Clean URL (Centered, no button box)
    url_y = H - 220
    url_text = CARD4_URL
    u_bbox = draw.textbbox((0, 0), url_text, font=fonts['h3'])
    u_w = u_bbox[2] - u_bbox[0]
    ux = (W - u_w) // 2
    
    # Draw a subtle divider above the URL
    draw.rectangle([W//2 - 100, url_y - 20, W//2 + 100, url_y - 18], fill=CYAN_DIM)
    draw.text((ux, url_y), url_text, font=fonts['h3'], fill=CYAN)
    
    draw_bottom_bar(draw)
    draw_wordmark(draw, fonts)
    
    # Tagline right-aligned with a 60px margin from the edge
    tagline = "Security awareness starts here."
    t_bbox = draw.textbbox((0, 0), tagline, font=fonts['small'])
    text_width = t_bbox[2] - t_bbox[0]
    
    # Calculation: Screen Width - Text Width - Margin
    tx = W - text_width - 60 
    
    # Keeping H - 125 to stay perfectly level with the bottom bar elements
    draw.text((tx, H - 125), tagline, font=fonts['small'], fill=GRAY_MID)
    
    return img

# ── MAIN ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print(f"\nCyberSense Carousel Generator – Edition {EDITION_NUMBER}")
    print("=" * 50)
    fonts = load_fonts()
    print("Rendering cards...")
    cards = [
        (make_card1(fonts), f"carousel_e{EDITION_NUMBER}_card1_cover.png"),
        (make_card2(fonts), f"carousel_e{EDITION_NUMBER}_card2_vulnerability.png"),
        (make_card3(fonts), f"carousel_e{EDITION_NUMBER}_card3_mitigation.png"),
        (make_card4(fonts), f"carousel_e{EDITION_NUMBER}_card4_cta.png"),
    ]
    for img, name in cards:
        path = os.path.join(OUTPUT_DIR, name)
        img.save(path, "PNG")
        print(f"  ✓ {name}")
    print(f"\nDone – 4 cards saved to: {os.path.abspath(OUTPUT_DIR)}")
    print("Fonts cached in: .font_cache/")