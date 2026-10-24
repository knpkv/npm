---
"@knpkv/hub-app": patch
"@knpkv/herdr-hub": patch
---

The Sandboxes owner is an allowed login from any tailnet node, not only the hub machine, so the owner signs the hub in to AWS and runs sandbox jobs from any device they use the hub on. Fleet approvals stay limited to approval nodes. `ModuleCaller` gains `owner`.
