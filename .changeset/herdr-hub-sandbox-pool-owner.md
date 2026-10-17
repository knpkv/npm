---
"@knpkv/herdr-hub": minor
---

The host that owns the sandbox pool can run Fleet `sandbox.*` jobs. `openSandboxDatabase` keeps the pool's records and reset run log in one private SQLite database. `makeSandboxPool` runs lease, extend, release, reset and budget-lift jobs, with the job's actor as the lease holder and the reset inside the release or reset job, and a `sweepOnce` that expires leases and resumes interrupted resets. `withSandboxOperations` adds the jobs to a host's operations. Nothing is wired into hostd by default: the host supplies `PoolAccess`, `Nuke` and `BudgetControl`.
