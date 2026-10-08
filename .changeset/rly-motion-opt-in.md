---
"@knpkv/rly": minor
---

Motion is opt-in: every rly transition and animation now runs only under `prefers-reduced-motion: no-preference`, so a reader who asks for less motion gets none, not just zero-length motion. Adds two easing tokens, `--rly-easing-out` (entering, leaving, answering a press) and `--rly-easing-in-out` (something on screen turning or moving), exported as `RLY_EASING_TOKEN_NAMES`. The `slow` duration drops from 360ms to 300ms. The per-duration `--rly-motion-*-easing` variables stay, as ease-out.
