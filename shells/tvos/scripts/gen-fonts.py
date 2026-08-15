#!/usr/bin/env python3
"""Bake the web's variable woff2 fonts into static TTFs tvOS can register.

The web ships ONE file per family and lets the browser interpolate the weight
axis (`font-weight: 300 700` in shared/theme.css). Neither half of that works
here: CoreText cannot read woff2 at all, and while it does support OpenType
variations, reaching a weight through SwiftUI means building a UIFontDescriptor
with an axis dictionary at every call site instead of naming a face. Baking the
weights the design system actually uses buys back `Font.custom("Fredoka-SemiBold")`
and costs ~200 KB.

WHICH WEIGHTS: exactly the ones the CSS names, scraped rather than guessed —
`grep -oE 'font-weight: *[0-9]+' public/shared/theme.css public/display/display.css`
gives 200, 300, 600, 700, 800. Fredoka's axis stops at 700, so its 800 requests
clamp there (the browser does the same); Nunito's runs to 1000 and covers all
five. Adding a weight to the CSS means adding it here.

The OUTPUT IS COMMITTED, under TinyTrackParty/Resources/Fonts/. It is generated
build output like the .filamat blobs, but unlike those it needs fontTools +
brotli, which are not repo dependencies — a checked-in TTF keeps `xcodegen &&
xcodebuild` the whole build, and this script is what you run on the rare day the
woff2 files are refreshed.

    pip install fonttools brotli
    shells/tvos/scripts/gen-fonts.py

The SIL OFL requires the license to travel with the font, so the two OFL texts
are copied alongside — same obligation the web tree satisfies in
public/assets/fonts/.
"""

import pathlib
import shutil
import sys

try:
    from fontTools.ttLib import TTFont
    from fontTools.varLib import instancer
except ImportError:
    sys.exit("needs fontTools + brotli:  pip install fonttools brotli")

ROOT = pathlib.Path(__file__).resolve().parents[3]
SRC = ROOT / "public" / "assets" / "fonts"
OUT = ROOT / "shells" / "tvos" / "TinyTrackParty" / "Resources" / "Fonts"

# (file, family, {weight: style-name}). The style names are what CoreText
# reports as the face name, so they are what Swift's Font.custom() spells.
FAMILIES = [
    ("fredoka-variable.woff2", "Fredoka", {
        300: "Light", 600: "SemiBold", 700: "Bold",
    }),
    ("nunito-variable.woff2", "Nunito", {
        200: "ExtraLight", 300: "Light", 600: "SemiBold", 700: "Bold", 800: "ExtraBold",
    }),
]


def bake(src: pathlib.Path, family: str, weights: dict) -> None:
    for wght, style in sorted(weights.items()):
        font = TTFont(src, fontNumber=0)
        axis = next(a for a in font["fvar"].axes if a.axisTag == "wght")
        # Fredoka's axis tops out at 700; a request past it clamps, exactly as the
        # browser clamps a font-weight past the declared range.
        value = min(max(wght, axis.minValue), axis.maxValue)
        instancer.instantiateVariableFont(font, {"wght": value}, inplace=True)

        # Rename so the baked instance is a NAMED FACE rather than a variable
        # font's default. 1/2 are the legacy family/subfamily pair CoreText keys
        # on; 4 is the full name; 6 the PostScript name Font.custom() takes.
        post = f"{family}-{style}"
        full = f"{family} {style}"
        name = font["name"]
        for nid, text in ((1, family), (2, style), (4, full), (6, post),
                          (16, family), (17, style)):
            name.setName(text, nid, 3, 1, 0x409)   # Windows / Unicode BMP / en-US
            name.setName(text, nid, 1, 0, 0)       # Macintosh / Roman / English
        # OS/2 usWeightClass is what UIFont's weight trait is read from; leaving
        # it at the variable default makes every baked face report the same
        # weight and the system pick arbitrarily among them.
        font["OS/2"].usWeightClass = wght

        font.flavor = None  # woff2 in, plain TTF out
        dest = OUT / f"{post}.ttf"
        font.save(dest)
        print(f"  {dest.name}  ({dest.stat().st_size // 1024} KB, wght {value:g})")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for filename, family, weights in FAMILIES:
        src = SRC / filename
        if not src.exists():
            sys.exit(f"missing {src}")
        print(f"{family}:")
        bake(src, family, weights)
    for licence in ("OFL-Fredoka.txt", "OFL-Nunito.txt"):
        shutil.copy2(SRC / licence, OUT / licence)
    print(f"==> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
