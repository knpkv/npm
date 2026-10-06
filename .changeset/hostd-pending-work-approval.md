---
"@knpkv/herdr-approvals": minor
---

Hostd composers receive `hasPendingWorkApproval`: whether any Work job is waiting for approval in hostd's job store, so a background Work writer can defer its writes and keep pending approvals valid. `makeHostdOperations` takes the job store as an optional third argument, and `makeHostdProgram` now opens the job store before composing operations.
