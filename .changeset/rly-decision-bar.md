---
"@knpkv/rly": minor
---

Add `DecisionBar`: approve or reject one named target. The target and its clock stay visible, and both actions carry the target in their accessible names. An `off` state keeps them focusable with the reason linked, and `sending` waits for the server's answer instead of assuming success. `placement="sticky"` pins the bar at thumb reach on phones.
