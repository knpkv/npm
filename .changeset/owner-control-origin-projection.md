---
"@knpkv/browser-pairing": minor
---

Add `readOrigin` to `makeWebControl` for read-only projection of a canonical HTTP loopback
origin from the owner-private control file. Reuse private-path checks without decoding
the bearer token, requesting login or changing files. Unsafe or missing registrations
fail as `WebNotRunning` without retaining private causes.
