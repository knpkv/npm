---
"@knpkv/bounded-io": minor
---

Add `collectTail` and `collectTailText`: read a stream to its end and keep only its last `limit` bytes, reporting how many were dropped. The text form starts on a character boundary.
