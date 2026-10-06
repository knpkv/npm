---
"@knpkv/herdr-approvals": minor
---

Hostd composers receive `hasOutstandingWorkJob`: whether any Work job in hostd's job store is still to run (pending approval, queued or running), so a background Work writer can defer its writes and keep pending approvals valid. `makeHostdOperations` takes the job store as an optional third argument, and `makeHostdProgram` now opens the job store before composing operations.
