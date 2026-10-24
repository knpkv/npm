---
"@knpkv/hub-app": patch
"@knpkv/herdr-hub": patch
---

The Sandboxes owner is an allowed login on any tailnet node that is not a fleet host, not only the hub machine, so the owner signs the hub in to AWS and runs sandbox jobs from their own devices. Fleet approvals stay limited to approval nodes. `ModuleCaller` gains `owner`.
