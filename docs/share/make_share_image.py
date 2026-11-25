"""Render the link-preview image and the small PNG icons from their HTML/SVG sources.

Run from the repository root with the project's Python environment (Playwright + Chromium):
    & "$HOME\\.venvs\\weatherai\\Scripts\\python.exe" docs/share/make_share_image.py

Writes public/og-image.png (1200x630), public/icons/favicon-32.png and the 96 px
shortcut icons used by the installed app's long-press menu.
"""

from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "public"

# Pixel-art page icons for app shortcuts, 16x16 grids drawn in the app's palette.
SHORTCUT_ICONS = {
    "forecast": """
      <rect width="16" height="16" fill="#c0c0c0"/>
      <rect x="1" y="2" width="14" height="13" fill="#ffffff"/>
      <rect x="1" y="2" width="14" height="3" fill="#000080"/>
      <rect x="4" y="1" width="1" height="3" fill="#000000"/><rect x="11" y="1" width="1" height="3" fill="#000000"/>
      <rect x="3" y="7" width="2" height="2" fill="#008080"/><rect x="7" y="7" width="2" height="2" fill="#008080"/>
      <rect x="11" y="7" width="2" height="2" fill="#008080"/><rect x="3" y="11" width="2" height="2" fill="#008080"/>
      <rect x="7" y="11" width="2" height="2" fill="#ffff00"/><rect x="11" y="11" width="2" height="2" fill="#008080"/>
      <rect x="1" y="15" width="15" height="1" fill="#808080"/><rect x="15" y="2" width="1" height="14" fill="#808080"/>
    """,
    "map": """
      <rect width="16" height="16" fill="#c0c0c0"/>
      <rect x="1" y="2" width="14" height="12" fill="#008080"/>
      <rect x="3" y="4" width="5" height="3" fill="#7fd17f"/><rect x="4" y="7" width="3" height="3" fill="#c7e05a"/>
      <rect x="9" y="6" width="4" height="5" fill="#f2d43c"/><rect x="10" y="9" width="2" height="2" fill="#f59d2a"/>
      <rect x="11" y="3" width="1" height="4" fill="#000000"/><rect x="10" y="3" width="3" height="1" fill="#000000"/>
      <rect x="1" y="14" width="15" height="1" fill="#808080"/><rect x="15" y="2" width="1" height="13" fill="#808080"/>
    """,
}


# Wraps one 16x16 pixel icon in a bare page, drawn at the given size with sharp pixel edges.
def svg_page(body: str, size: int) -> str:
    return (
        f"<html><body style='margin:0;background:transparent'>"
        f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' width='{size}' height='{size}' "
        f"shape-rendering='crispEdges'>{body}</svg></body></html>"
    )


def main() -> None:
    """Render og-image.png, the 32 px favicon and the shortcut icons with headless Chromium."""
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1200, "height": 630}, device_scale_factor=1)
        page.goto((ROOT / "docs" / "share" / "share-image.html").as_uri())
        page.evaluate("document.fonts.ready")
        page.screenshot(path=str(PUBLIC / "og-image.png"))

        favicon = (PUBLIC / "favicon.svg").read_text(encoding="utf-8")
        inner = favicon[favicon.index(">") + 1 : favicon.rindex("</svg>")]
        icons = {"favicon-32": (inner, 32)} | {f"shortcut-{k}": (v, 96) for k, v in SHORTCUT_ICONS.items()}
        for name, (body, size) in icons.items():
            small = browser.new_page(viewport={"width": size, "height": size}, device_scale_factor=1)
            small.set_content(svg_page(body, size))
            small.screenshot(path=str(PUBLIC / "icons" / f"{name}.png"), omit_background=True)
            small.close()
        browser.close()
    print("wrote og-image.png, favicon-32.png and shortcut icons")


if __name__ == "__main__":
    main()
