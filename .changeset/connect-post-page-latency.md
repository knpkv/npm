---
"@knpkv/herdr-connect": patch
---

Let post pages read retained reports during local post and self-state write backoff. Keep page SQL read-only and secure lazy database sidecars to 0600 before returning, without waiting for the writer transaction permit.
