---
"@knpkv/rly": patch
---

The bounded diff view uses logical borders and alignment, and its code is pinned left to right (isolated), so an RTL host never mirrors code. Centred text that can overflow falls back to the start edge where `safe center` is supported (an `@supports` block, so older browsers keep `center`); shrink-wrapped marks and avatars stay plainly centred. Sheets and the Relay dock size to `100dvh` without a `100vh` fallback.
