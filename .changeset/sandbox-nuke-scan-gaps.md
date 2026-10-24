---
"@knpkv/sandbox-pool": patch
---

A reset's scan no longer quarantines on resource types a pool account cannot hold: aws-nuke now skips retired, subscription-only, admin-only and SCP-denied types, and a type whose service has no endpoint in one region is not an incomplete scan there.
