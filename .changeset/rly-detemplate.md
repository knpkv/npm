---
"@knpkv/rly": minor
"@knpkv/control-center": patch
---

Controls default to tool density: `Button`, `IconButton`, `Select`, and the `Field` control gain a `dense` size (32px, small radius, sized to text) and use it when no size is given (`ThemeSelect` and the `AgentJob` cancel action too), through new shared `--rly-control-height-*` tokens (`RLY_CONTROL_HEIGHT_TOKEN_NAMES`). Compact `IconButton` is 40px like the other compact controls (it was 44); the registry lists `dense` as the default size. Coarse pointers keep a 44px target. One-sided accent stripes are gone from rly: diff annotations, the file-tree error, stale findings, agent outcomes, thread evidence, verdict reasons, workset gaps, and the `StatePanel` rail now use an even border or a flat tint, and `lint:stripes`, now part of the repository lint gate, keeps them from coming back. The diff file tree marks the open file with an even ring and draws its guide lines in the neutral divider colour. A neutral `StatePanel` shows no icon unless `icon` names one. Control Center's header actions, Settings inputs and selects, and service setup fields move to the same dense height, so they line up with rly buttons.
