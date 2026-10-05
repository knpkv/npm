---
"@knpkv/rly": minor
"@knpkv/control-center": patch
---

Controls default to tool density: `Button`, `IconButton`, `Select`, and the `Field` control gain a `dense` size (32px, small radius, sized to text) and use it when no size is given, through new shared `--rly-control-height-*` tokens (`RLY_CONTROL_HEIGHT_TOKEN_NAMES`). Coarse pointers keep a 44px target. One-sided accent stripes are gone from rly: diff annotations, the file-tree error, stale findings, agent outcomes, thread evidence, verdict reasons, workset gaps, and the `StatePanel` rail now use an even border or a flat tint, and `lint:stripes` keeps them from coming back. A neutral `StatePanel` shows no icon unless `icon` names one. Control Center's header actions, Settings inputs and selects, and service setup fields move to the same dense height, so they line up with rly buttons.
