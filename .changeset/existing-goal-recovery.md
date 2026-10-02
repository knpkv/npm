---
"@knpkv/herdr-work": minor
"@knpkv/herdr-approvals": minor
"@knpkv/herdr-fleet": minor
"@knpkv/herdr-coordinator": minor
---

Recover an existing unlinked canonical Work goal through a read-only recovery context and preflight, then an approved, history-guarded recovery that links it to an exact worker without rewriting its original checkpoint. Accept the exact legacy worktree repository representation, add prospective PR admission preflight, and expose the recovery and admission routes through fleetctl and the approvals HTTP API. Add typed work.admit, work.recover and work.reconcile Fleet operations, which a host accepts at submission only when its composed Work adapter declares them in `HostOperations.workJobKinds`, and bot-review and formal-review evidence in pull-request evidence.
