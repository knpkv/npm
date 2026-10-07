---
"@knpkv/herdr-approvals": minor
---

The hostd composer receives `startedWorker(jobId)`, the worker Fleet's job record says that job started, or null when the job is unknown or started none. A background writer that acts on an agent can check its identity against this record instead of pane metadata, which any local agent can write. A job store that can't be read, or a composition without one, fails with `FleetStoreError`, never null.
