---
"@knpkv/rly": patch
---

Clipping containers use `overflow: clip` instead of `hidden`, so they are no longer accidental scroll containers: moving focus to a partly clipped child can't scroll their content out of place, and sticky descendants work. Painting is unchanged.
