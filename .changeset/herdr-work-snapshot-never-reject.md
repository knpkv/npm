---
"@knpkv/herdr-work": minor
---

Recording work never fails because the board has grown. The snapshot-size and goal-count checks on writes are gone; the snapshot bounds itself instead, leaving out finished goals first (least recently updated first) and counting them per window in the new optional `goalsOmitted`. Older readers ignore the key.
