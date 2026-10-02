---
"@knpkv/herdr-work": minor
"@knpkv/herdr-fleet": minor
"@knpkv/herdr-approvals": minor
---

Add the approval-gated `work.reassign` Fleet operation. It moves one Work goal, and its active lane, from the exact current owner to a new owner in one transaction guarded by the goal's expected head event. The request names the agent outcome explicitly: `set` moves the goal's agent target and rebinds a bound lane to the new worker, `clear` removes the target, and `keep` is accepted only when the goal has none. A shipped lane keeps its previous owner, and admission preflight treats each lane's latest binding as its authority, so a rebound lane still reads as existing for its new worker. The new checkpoint records who approved it, the activity summary is bounded before approval, and replaying the same approval job is idempotent. Approvals render the request, fleetctl can submit it, and `runWorkReassign` executes it from a composed host.

Follow-up, not covered here: lane claims and checkpoint appends can still change an owner without an approved reassignment.
