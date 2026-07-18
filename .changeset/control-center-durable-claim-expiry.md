---
"@knpkv/control-center": patch
"@knpkv/control-center-sql": patch
---

Expire governed-action recovery claims durably during graceful shutdown and let startup recovery reclaim explicitly expired work without waiting for the original lease deadline.
