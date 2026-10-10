---
"@knpkv/herdr-hub": minor
---

`@knpkv/herdr-approvals` is now `@knpkv/herdr-hub`: the package serves the whole hub (Approvals, Connect, Work, Usage and Relay), not approvals alone. The `hostd` and `fleetctl` binaries and every export path (`.`, `./fleetctl`, `./hostd`, `./hostd-runtime`) are unchanged; install `@knpkv/herdr-hub` in place of `@knpkv/herdr-approvals`, which is deprecated.
