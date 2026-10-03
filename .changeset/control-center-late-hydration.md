---
"@knpkv/control-center": patch
---

Keep a freshly paired browser session when the startup session check finishes after pairing. With React 19.3 the lazily loaded check can start late, and its stale result no longer signs the tab out.
