---
"@knpkv/rly": minor
---

Load Geist and Geist Mono with `font-display: optional`, so a late font keeps the metric-matched fallback for that page view instead of swapping in and shifting text, and add `RLY_FONT_FACES`, the font files a shell must preload for Geist to render on first load.
