---
"@knpkv/control-center": patch
---

Browser sessions ("Revoked", "last used", the pairing code's expiry), a stale release target ("Stale since"), and authorized shares (the link's expiry, and the shared item's observed and expiry times) now read as "14 Jul 2026, 10:00 UTC" instead of raw ISO text, each inside a `<time datetime>` with the exact instant.
