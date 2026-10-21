---
"@knpkv/herdr-hub": minor
---

The Sandboxes page can lease, extend and release for the pool owner. `GET /v1/modules/sandboxes/caller` says who is reading and whether that is the hub's own node. `POST /v1/modules/sandboxes/jobs` takes `{ _tag: "Lease" }`, `{ _tag: "Extend", accountId }` or `{ _tag: "Release", accountId }` and submits the existing `sandbox.lease`, `sandbox.extend` or `sandbox.release` Fleet job as the caller. It answers 202 with the job id, 403 for any node but the hub's own, 409 when Fleet refuses the job, and 503 where the pool is not served. Like every module write, it requires the page's own origin. Every other viewer still sees the page read-only.
