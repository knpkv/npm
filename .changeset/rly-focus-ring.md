---
"@knpkv/rly": minor
---

One focus ring everywhere: a solid 2px outline in the focus colour, 2px outside the control, from the new `--rly-focus-ring-width` and `--rly-focus-ring-offset` tokens. The base ring goes from 3px to 2px, and the diff, table, timeline, and toggle rings that used 3px or ad-hoc offsets now match. `lint:colors` rejects a focus outline with a raw width.
