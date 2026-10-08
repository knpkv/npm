---
"@knpkv/rly": patch
---

The bounded diff view uses logical borders and alignment, so it mirrors in right-to-left layouts. Centred content falls back to the start edge when it overflows (`safe center`) instead of being cut off on both sides. Sheets and the Relay dock size to `100dvh` without a `100vh` fallback.
