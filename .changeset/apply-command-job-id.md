---
"@knpkv/herdr-approvals": minor
---

The default operations now run `nix.apply` as the apply command followed by the ref and then the Fleet job id, so the apply command can record that job's own outcome. A host that restarts mid-apply can then settle the job from that record. An apply command that takes only the ref must ignore the second argument.
