---
"@knpkv/control-center": patch
---

Route CodePipeline state reads through a shipped AWS adapter that accepts action revisions whose optional change identifier and creation time are omitted, and expose fixed, secret-free live probe failure stages for post-deployment diagnosis.
