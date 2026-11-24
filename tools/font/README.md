# Red Queen Glass

The display face of the Red Queen site: Bodoni Moda recut as cut crystal. Every thick stroke carries a hairline
channel of light down its core, widest in the heaviest part of a stem or bowl and tapering to a point where the
stroke thins towards a hairline, like light caught inside a glass ribbon. Hairlines, serifs, ball terminals and
dots stay solid. Two signature details: the capital Q's tail is redrawn as a long ribbon that sweeps under the
next letter and thins to a hairline (it is the hero word, "Queen"), and the tittles of i and j are lozenges.

Files (served from `web/public/fonts/`):

| File | What |
| --- | --- |
| `red-queen-glass-roman.woff2` | Red Queen Glass Regular (Bodoni Moda Roman, opsz 96, wght 500) |
| `red-queen-glass-italic.woff2` | Red Queen Glass Italic (Bodoni Moda Italic, opsz 96, wght 500) |
| `OFL.txt` | SIL Open Font License 1.1, Bodoni Moda's copyright plus a line for this modification |

## How it is built

`python3 tools/font/build_font.py` (add `--no-specimens` to skip the PNGs, `--ttf DIR` to also write TTFs).
It needs fontTools, skia-pathops, numpy, scipy, shapely, contourpy and brotli; uharfbuzz and matplotlib for the
specimens; opentype-sanitizer is optional (it runs the same parser Chrome and Firefox run on web fonts). A run
takes a few minutes and is deterministic.

1. **Source.** The Bodoni Moda latin subsets that `next/font/google` downloads (variable, wght 400–900, opsz
   6–96), kept in `tools/font/source/` with their licence. If they are missing the script finds them in
   `web/.next/static/media` by their name tables and copies them in.
2. **Instance.** `fontTools.varLib.instancer` at opsz 96 (the display optical size, hairlines at their
   finest) and wght 500.
3. **Clean outlines.** Each glyph is decomposed and its overlaps removed with skia-pathops. Every result is
   checked against an exact scanline nonzero-area reference; where Skia silently drops shapes whose contours
   share edges (italic Œ did), the contours are nudged a hundredth of a unit apart and retried.
4. **Medial axis.** The outline is sampled every 4 units and the Voronoi diagram of the samples gives the
   medial axis: every axis point knows r, the half-width of the stroke there, and the object angle phi (180°
   where the two sides face each other, as in a stem; small where the axis runs off into a corner).
5. **The lit axis.** Keep the axis where r > r0 and phi ≥ 120°, prune side branches, cut it where it turns
   sharply (a corner prong), drop short pieces. Along what is left, filter r with a morphological opening (so
   a hairline joining a stem does not leave a bead), then
   `rho = cap · tanh(k · (r − r0) / cap)`, diffuse rho along the axis, multiply by a smoothstep taper towards
   every free end, and low-pass the axis position (Taubin smoothing).
6. **The channel.** The union of discs of radius rho swept along the lit axis, traced from a distance-like
   field on a 1-unit grid (contourpy), fitted with cubic Béziers (Schneider's algorithm, 0.4-unit tolerance,
   the tips kept sharp) and converted to TrueType quadratics (cu2qu, 0.3 units). This is the inset
   `core = {p : dist(p, edge) > d}` of the brief generalised with a gain k < 1: k = 1, cap = ∞ and no taper
   is exactly the inset by d = r0, whose ends are blunt; k < 1 turns them into clean points and keeps the light
   a hairline.
7. **Glyphs.** The base glyph is the clean outline with the channel cut out as holes (same contours, reversed),
   so a browser without colour fonts still gets the crystal. The channel is also its own glyph, `name.glass`.
   Composite glyphs (accented letters, tabular figures) stay composites and get composite `.glass` glyphs;
   composites whose parts overlap (œ) are merged and lit as one glyph. New glyphs are appended after the
   original glyph order, so the cmap, GSUB, GPOS kerning and mark positioning are untouched.
8. **Colour.** COLRv0 + CPAL. Each lit glyph has two layers: `name.body` (a composite of the holed base glyph)
   on palette index 0xFFFF, which follows CSS `color`, and `name.glass` on palette index 0.
9. **Names and licence.** Every name record says Red Queen Glass; version 1.000. Bodoni Moda declares no
   Reserved Font Name, and the new name avoids it anyway.
10. **Checks.** For every glyph not redrawn on purpose, base + channel area equals Bodoni Moda's; a point inside
    every channel is a hole in the base glyph and filled in the channel layer; OTS accepts the font.

## Parameters

Lengths are fractions of W, the stem width of `l`, measured on the instance (208 units roman, 181 italic, on a
2000-unit em).

| Parameter | Value | Effect |
| --- | --- | --- |
| r0 | 0.27 W | strokes thinner than 0.54 W (54% of a stem) carry no light: hairlines, serifs, thin diagonals |
| k | 0.30 | gain: channel half-width per unit of stroke half-width above r0 |
| cap | 0.09 W | soft cap (tanh) so heavy bowls do not out-shine stems |
| phi_lo | 120° | the axis goes dark where it runs into a corner |
| prune / kink | 0.5 W / 28° over 0.08 W | side branches and corner prongs removed |
| mincomp / min_rho | 0.6 W / 0.025 W | lit pieces shorter or fainter than this are dropped (dots, ball terminals, spurs) |
| open | 0.5 W | opening radius along the axis (no beads at junctions) |
| smooth / pos_smooth | 0.1 W / 0.3 W | smoothing of the width profile and of the axis position |
| taper | 1.2 W | the light tapers to a point over this length at each free end |

Measured on the built fonts: the channel is 24 units wide in the middle of `l` (11.5% of its 208-unit stem), 27
in capital stems (12% of 225), 27 in the sides of `o` and 31 in `O` and `0` (12% of their 263-unit stroke); in
the italic 22 in `l` (11.6%) and 30 in `O` (11.4%). The soft cap is what keeps bowls and stems at one hairline
weight: without it the light in `O` would be about 1.6 times as wide as in a stem.

Q tail (roman; the italic follows the slant): a ribbon along two cubic spines from the bowl's foot to
(1790, −365), widths 262 → 225 → 100 → 22 → 2 units by arc length, clipped by the counter and merged with the
bowl. Lozenge tittles: 270 × 350 units, centred on the old dot, slanted with the italic; the Turkish i
(`i.loclTRK`) gets one too. Nothing else changes shape, and every advance width and kerning pair is Bodoni
Moda's.

## Palette

| CPAL palette | Index 0: the channel | Index 0xFFFF: the body |
| --- | --- | --- |
| 0 (default) | `#cfe9ef` at 85% (`#cfe9efd9`), cool glass light | CSS `color` |
| 1 | `#e8372c`, refused | CSS `color` |

## Using it

```css
@font-face {
  font-family: "Red Queen Glass";
  src: url("/fonts/red-queen-glass-roman.woff2") format("woff2");
  font-weight: 400 500; /* one static cut (wght 500) answers both weights the site uses */
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "Red Queen Glass";
  src: url("/fonts/red-queen-glass-italic.woff2") format("woff2");
  font-weight: 400 500;
  font-style: italic;
  font-display: swap;
}
@font-palette-values --rq-glass {
  font-family: "Red Queen Glass";
  base-palette: 0;
  override-colors: 0 #cfe9efd9; /* the channel; the body is CSS color */
}
@font-palette-values --rq-refused {
  font-family: "Red Queen Glass";
  base-palette: 1; /* the light turns #e8372c */
}
```

Set `color` for the glass and `font-palette: --rq-glass` (or `--rq-refused`) for the light. The palette rules
must name the family exactly as the `@font-face` does, which is why the font is declared in plain CSS rather than
through `next/font/local` (that renames the family).

## Specimens

Rendered by the build with its own rasteriser (HarfBuzz shaping with the font's kerning, fontTools outlines
filled by matplotlib's Agg with the nonzero rule, as browsers fill), light on `#050608`:

- `specimen-hero.png`: "Red Queen" before (Bodoni Moda) and after, hollow and COLR, at 180 and 64 px; "Refused."
  with the light turned red.
- `specimen-180-colr.png`, `specimen-180-hollow.png`, `specimen-64-colr.png`, `specimen-64-hollow.png`: the
  site lines, the digits and both alphabets in both styles.
- `specimen-detail.png`: o e a s g R Q B 0 3 8 at 400 px, roman and italic, hollow and COLR.
