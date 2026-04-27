# anonovox · poster theme + icon kit

Assets for building a 28″ × 22″ capstone poster, derived from the existing
`design-system.css` and the live site at `/index.html`.

## Layout

```
poster-assets/
├── index.html              ← preview: open in a browser to see all 3 themes + every icon
├── themes/
│   ├── tokens.json         ← single source of truth for all theme color/type tokens
│   ├── light.css           ← Royal Blue + Creme (matches site default)
│   ├── dark.css            ← Midnight Sapphire (matches site dark-mode)
│   └── print.css           ← Capstone Print: deeper inks, warmer paper, CMYK-safe
└── icons/
    ├── concept/            ← 8 product-concept icons
    ├── stack/              ← 8 tech-stack icons
    └── decor/              ← 7 structural / ornamental SVGs
```

## How to use

**In a layout tool (Figma / Illustrator / PowerPoint / Keynote)**
Drop the SVGs in directly. They use `currentColor`, so set the SVG fill/stroke
to whichever accent (`#2c3e7a` light, `#6b8ee4` dark, `#1d2d63` print) matches
your background.

**In an HTML/React mockup of the poster**
Add one of the theme classes to a wrapping element and inline the SVG:

```html
<section class="theme-print">
  <div style="color: var(--accent)">
    <!-- inline the icon SVG here, currentColor will resolve -->
  </div>
</section>
```

**For literal print**
Use the `print` theme. The accent (`#1d2d63`) is darkened to compensate for
the way CMYK shifts royal blue toward periwinkle on matte stock; the cream
background (`#f7f0e6`) is warmed slightly so the paper does not look gray
under fluorescent gallery lighting.

## Suggested poster grid (28″ × 22″ landscape)

```
┌─ 0.5″ safe margin ───────────────────────────────────────┐
│  WORDMARK · TAGLINE                                     │
│  ─────────────────────────────────────────────────────  │
│  ┌─ PROBLEM ──┐ ┌─ SOLUTION ──┐ ┌─ ARCHITECTURE ──┐    │
│  │            │ │             │ │  (stack icons)   │    │
│  └────────────┘ └─────────────┘ └──────────────────┘    │
│  ┌─ HOW IT WORKS (3-step row, step-frame icons) ─┐     │
│  └────────────────────────────────────────────────┘     │
│  ┌─ FEATURES (concept icons in a 2×3 grid) ──┐          │
│  └─────────────────────────────────────────── ┘          │
│  CALL-OUT QUOTE · BADGE-SEAL                            │
└──────────────────────────────────────────────────────────┘
```

The `corner-ornament` is designed for the four corners (mirror with
`transform: scaleX(-1)` and/or `scaleY(-1)`); the `section-divider` and
`vertical-spine` map directly to the rules already used in the live site.
