# App Icons

## ✅ LIVE — do not replace without intent
- **`icon.svg`** — the shipping icon. PDX airport carpet field + river/route ribbon + white hero bike + rose (Rose City destination).
- Rasterized to the assets actually used:
  - `public/icon-192.png`, `public/icon-512.png` (+ `dist/` copies) — web PWA / favicon (rounded, transparent corners)
  - `../ios/BikeRouteNicePDX/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png` — iOS (square, no alpha)
- Preview: `icon-preview.png`

## Alternatives (NOT live — kept for reference)
- **`icon-alt.svg`** — original + Douglas fir at the **route origin (bottom-left)**. Preview: `icon-alt-preview.png`
- **`icon-alt2.svg`** — original + fir **upper-left** and **"PDX" wordmark lower-right**. Preview: `icon-alt2-preview.png`

To promote an alt to live: rasterize it over the filenames in the LIVE section above
(via `sharp`, `density: 400`; iOS variant uses `rx="0"` for square full-bleed + `.flatten()` for no alpha).
