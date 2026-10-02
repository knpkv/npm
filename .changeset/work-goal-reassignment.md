---
"@knpkv/herdr-work": minor
"@knpkv/herdr-fleet": minor
"@knpkv/herdr-approvals": minor
---

Add the approval-gated `work.reassign` Fleet operation. It moves one Work goal, and its active lane, from the exact current owner to a new owner in one transaction guarded by the goal's expected head event. The new checkpoint records who approved it, and replaying the same approval job is idempotent. Approvals render the request, fleetctl can submit it, and `runWorkReassign` executes it from a composed host.
