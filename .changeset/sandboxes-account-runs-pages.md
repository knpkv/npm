---
"@knpkv/herdr-hub": minor
---

Add the Sandboxes account page at `#sandboxes/account?id=` and the runs page at `#sandboxes/runs?id=`. The account page, where needs-you already links, shows a quarantine's blocker words, run id, since and failed step, a budget stop in caution words, and any reset or budget lift waiting in Fleet / Approvals with a link there. The runs page lists reason, outcome, duration and start, and a row opens that run with the failed step's blocker words. The overview puts quarantine first as the only red, then budget stops, and marks a pending request "Approval requested". New `GET /v1/modules/sandboxes/requests` lists pending sandbox resets and lifts with the requester's login, behind the module's authorization. `makeSandboxesModule` takes `pendingApprovals` in place of `pendingLifts`, and `SandboxesModuleReads` gains `runs` and `requests`.
