---
"@knpkv/herdr-fleet": patch
---

Refuse a fleet configuration that lists one node both as a fleet machine and in `approvalNodes`. Fleet machines run agents under the owner's login, so a machine never approves.
