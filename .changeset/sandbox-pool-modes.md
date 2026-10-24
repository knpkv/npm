---
"@knpkv/herdr-hub": minor
"@knpkv/sandbox-pool": minor
---

A host's sandbox pool now runs from its fleet configuration: `makeSandboxPoolFromConfig` reads `sandboxPool.mode` (off when absent; observe reads spend and refuses every write with no job kinds; live wires every AWS adapter) and signs in through the hub's own AWS sign-in as `sandboxPool.operator`. `sandbox-reset-check <account-id>` and `inspectReset` read what a reset would do, changing nothing in AWS.
