/**
 * Lease model and reset job for the pool of ephemeral AWS sandbox accounts.
 *
 * **Mental model**
 *
 * - One `Sandbox` record per pool account. The single hostd that owns the pool
 *   is its only writer and applies the pure transitions in `lease` with a
 *   compare-and-set on `version` through `SandboxStore`. Every other host
 *   reaches it through fleetctl jobs.
 * - Transitions never perform I/O. `resetAccount` is the one effectful job: it
 *   needs `PoolAccess` and `Nuke`, and turns any step failure into a Quarantined
 *   blocker. Only precondition errors (`AccountNotInPool`, `InvalidTransition`,
 *   `StaleRun`) fail it.
 * - The package ships no real organization. `PoolContract` is decoded from the
 *   owning host's configuration and supplies the account IDs, the aws-nuke
 *   blocklist, the regions and the role and boundary names.
 *
 * @module
 */
export * from "./budget.js"
export * from "./guard.js"
export * from "./lease.js"
export * from "./pool.js"
export * from "./reset.js"
export * from "./run-log.js"
export * from "./spend.js"
export * from "./store.js"
