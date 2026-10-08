# 07 — Compositing, Replacement & Upscaling (learned in practice)

Field notes from turning gpt-image-2 output into print-ready art (Apollo 13 exhibit,
2026-07-05: 2 large posters + 4 rank cards). Every command here is verified against
**this machine's ImageMagick 7 build**, which has quirks (see §0). Companion scripts:
`gen-panel2-v3-guidance-prime.js`, `gen-poster1-sm-refill.js`, `gen-cards-proof.js`.

## 0. Environment gotchas (read first)

- **No FreeType/Ghostscript in this `magick` build.** `-annotate`, `-label`, `montage -label`,
  any text drawing → `delegate library support not built-in 'none' (Freetype)` and fails.
  → Render text with **Pillow** (its own font engine) or composite pre-rendered text/icons.
  Vector primitives still work: `-draw "line x1,y1 x2,y2"`, `-draw "circle cx,cy px,py"`.
- **gpt-image-2 limits:** max edge 3840px, ≤ 8.29 MP, both edges ÷16, long:short ≤ 3:1.
  Print masters (e.g. 10800×14400 @300dpi) are therefore **upscaled** (§7).
- **Big-image ops are slow.** 155 MP (10800×14400) sharpen/composite runs 30 s–3 min and
  eats RAM — run them with `run_in_background`.

## 1. Keying gpt-image-2's backgrounds

gpt-image-2 has no transparent output (`background: transparent` is HTTP 400), so alpha is made
here. Which method works depends on the art.

**Outlined art (stickers, emoji, icons) on white: flood-fill from the corner.** A bold dark
outline stops the fill, so white inside the subject (eyes, highlights) survives. Pad by one
pixel first so the fill reaches every edge region, then shave it off:

```bash
magick in.png -alpha set -bordercolor white -border 1 -fuzz 12% -fill none \
       -draw "color 0,0 floodfill" -shave 1x1 -trim +repage out.png
```

White pockets fully enclosed by the outline (gaps between spires, say) stay white; check the
result flattened on a dark background.

**Unoutlined art on black: measure, don't threshold.**

gpt-image-2 renders a requested "pure black background" as a **uniform tinted off-black**,
not `#000000`. A trophy asked for "on pure flat black" came back on `srgb(102,75,26)` (a
30%-luminance dark gold). Luminance-threshold keying leaves a rectangular halo every time.

```bash
# 1) MEASURE the actual background color (sample a corner)
magick trophy.png -format "corner=%[pixel:p{20,20}]\n" info:      # -> srgb(102,75,26)
# 2) Key that exact colour (uniform bg -> clean cut), then feather the alpha
magick trophy.png -fuzz 22% -transparent "srgb(102,75,26)" keyed.png
magick keyed.png \( +clone -alpha extract -morphology Close Disk:1.5 -blur 0x1.2 -level 25%,75% \) \
       -alpha off -compose CopyOpacity -composite -trim +repage cut.png
```

Without an outline, threshold, black-threshold and floodfill all leave halos;
**measure + `-fuzz -transparent`** is the reliable fix. (Also note: `-draw "alpha x,y floodfill"` is rejected by this build.)

## 2. Recolor one grayscale asset into many "metals" (duotone CLUT)

One trophy → gold/platinum/bronze/steel by mapping luminance through a 3-stop gradient CLUT,
keeping alpha on the side:

```bash
mkclut(){ magick xc:black xc:"$2" xc:"$3" +append -filter Cubic -resize 256x1\! "clut-$1.png"; }
mkclut gold "#c8912f" "#ffe8a0"; mkclut platinum "#aab0b8" "#f4f6fb"
mkclut bronze "#b06a35" "#eaa46a"; mkclut steel "#7d97bb" "#d3e2f5"

recolor(){ magick cut.png -alpha extract _a.png
  magick \( cut.png -alpha off -colorspace Gray -auto-level "clut-$1.png" -clut \) \
         _a.png -alpha off -compose CopyOpacity -composite "trophy-$1.png"; }
```

Printed CMYK color (no foil) reads fine as "metal." First CLUT stop matters only if you skip
the separate alpha; keeping alpha via CopyOpacity makes the bg colour irrelevant.

## 3. Tile icons into a "count = length" row

```bash
# -background none MUST precede +smush, or the gaps fill white
magick trophy-gold.png -resize x220 -background none _t.png
magick _t.png -duplicate 9 -background none +smush 24 +repage row-gold-10.png   # 10 in a row
```

Fixed icon size + variable count → "more trophies = longer row," which reads as rank at a glance.

## 4. Replace a soft element inside a finished master (poster-1 SM swap)

Goal: swap a fuzzy AI/photo element for a sharp one **without disturbing** the rest (text,
callouts, logos). The recipe that worked:

1. **Match the aspect ratio.** Generate the replacement at the *target footprint's* aspect,
   not whatever the model likes. My first SM came out 2.2:1; the poster slot was ~1.5:1, so the
   old craft **peeked around** the new one. Re-render at the slot's aspect (crop the region, feed
   it as a framing ref) so it fills cleanly.
2. **Erase the old element first.** Paint a *feathered black blob* over the old footprint so no
   stale pixels can show through gaps.
3. **Composite the new element to cover:** `-resize WxH^ -gravity center -extent WxH` (fills, crops
   excess; same aspect = no crop).
4. **Restore the overlays** you erased (labels, callout lines, moon) from the ORIGINAL via tight
   cropped patches composited on top, and **redraw thin vector leader lines** (`-draw "line…"` +
   `-draw "circle…"`, `-stroke "#DC143C"`) since those were inside the erase zone.
5. **Feather every seam** (§10) so edges vanish into the dark background.

## 5. Keep an approved look but change the framing

When the human picks a candidate but it's framed wrong, don't re-roll blind — **anchor on the
pick**: feed the approved image as reference #1 ("reproduce EXACTLY the spacecraft, damage,
materials, lighting, and crisp style of reference 1"), a framing crop as reference #2, and
instruct "change ONLY the framing / zoom to fill." Preserves the look, fixes the composition.

## 6. Never let the model draw exact counts or critical text

gpt-image-2 miscounts icons and misspells (a prior run produced "MSISION CONTROL"). For anything
that must be exact — trophy counts, a QR, a serial — **reserve an empty band in the prompt** and
**composite the real element afterward** (deterministic). This is the same discipline as compositing
the real QR after generation.

## 7. Upscale to print DPI

```bash
magick in-2448x3264.png -filter Lanczos -resize 10800x14400 \
       -unsharp 0x1.1+0.5+0.004 -density 300 -units PixelsPerInch out-300dpi.png
```

Honest caveat: a ~4.4× upscale of a 3840-max render **adds no real detail** — it's fine for
large-format viewed at 3–10 ft, but don't expect crispness. If softness matters, fix it at the
generation stage (better source, higher native res, element swap), not by upscaling harder.

## 8. De-fuzz / sharpen a grainy photo region

```bash
# denoise THEN sharpen — plain unsharp alone just amplifies the grain
magick band.png -despeckle -despeckle -adaptive-sharpen 0x3 -unsharp 0x18+0.18+0 out.png
```

`-adaptive-sharpen` is edge-aware (better than `-unsharp` for photos). There's a hard ceiling:
you can't recover detail that isn't in the pixels.

## 9. Measure positions with a grid, not with trim

`-threshold -trim -format "%X"` gets **contaminated** by the frame, corner ticks, and other bright
content — it lied to me repeatedly. Instead overlay a labeled coordinate grid and *look*:

```bash
magick card.png -stroke cyan -strokewidth 2 \
  -draw "line 1800,0 1800,2176" -draw "line 2000,0 2000,2176" ... \
  -stroke red -strokewidth 4 -draw "line 2660,0 2660,2176" grid.png   # candidate center in red
```

If you must use trim, crop strictly **inside** the region of interest first (exclude frame/patch).

## 10. Feathered-composite helper (seams vanish into dark bg)

```bash
feather(){ IN=$1; B=$2; OUT=$3; WH=$(magick identify -format "%wx%h" "$IN"); W=${WH%x*}; H=${WH#*x}
  magick -size ${W}x${H} xc:white -shave ${B}x${B} -bordercolor black -border $B -blur 0x$((B/2)) _m.png
  magick "$IN" _m.png -alpha off -compose CopyOpacity -composite "$OUT"; }
# then: magick BASE layer_feathered.png -geometry +X+Y -compose over -composite OUT.png
```

## 11. Center in the panel, not under the text

A left-aligned title that runs to the frame makes a "centered-under-title" element look
**right-shifted**. Center composited rows in the actual **panel** (equal margin from the left
content edge to the right frame), not under the text block.

## 12. Workflow: generate → confirm → finalize

Because generation is non-deterministic and print runs are expensive: generate **best-of-N at max
quality/size**, show the human, get a pick, and only **then** upscale/composite/finalize. Never bake
the 100 MB master before the pick is confirmed.
