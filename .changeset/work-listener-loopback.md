---
"@knpkv/herdr-fleet": minor
"@knpkv/herdr-hub": patch
---

Restrict the unauthenticated Work-only listener to loopback. `workBindAddress` now accepts only `127.0.0.0/8` addresses, and the listener refuses Work snapshot and checkpoint requests from any non-loopback peer. Paired LAN access remains available through `lanWork`.
