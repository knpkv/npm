---
"@knpkv/control-center": patch
---

Retry offline database snapshot capture when a closing SQLite sidecar disappears, while failing closed if sidecar churn continues.
