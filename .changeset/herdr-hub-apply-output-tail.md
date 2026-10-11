---
"@knpkv/herdr-hub": minor
---

`nix.check` and `nix.apply` no longer stop the command when its output passes 128 KiB. The cap used to fail the job and terminate the command's process group mid-run, which could leave an activation half applied. These commands now run to completion, their exit code alone decides the job, and each stream keeps its last 64 KiB after an `[N earlier bytes omitted]` line. Output that is parsed still fails past 128 KiB.
