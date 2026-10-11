---
"@knpkv/browser-pairing": patch
---

The shared browser opener runs in the caller's process group, so the browser it starts is no longer killed when the opener exits.
