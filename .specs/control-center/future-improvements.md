# Control Center — future improvements after the authority checkpoint

This document records the deliberate cutoff made on 2026-07-15. The repository is left at a
tested, resumable checkpoint; the larger implementation roadmap is **not** being represented as
complete.

## Safe checkpoint delivered

- Runtime authority is persisted, derived from canonical runtime inputs, generation-bound, and
  revalidated before and after transaction callbacks.
- Runtime generations are retained so an `A → B → A` rotation cannot revive an old token.
- Governed execution inspection issues only short-lived preparation capabilities.
- Execution `begin` now receives the exact inspected workspace/connection scope, and the engine
  rejects cross-wired permits before calling a provider.
- Private strict readers load current session, target, projection, and evidence authority without
  falling back to older valid records.
- Referenced evidence items and claims are digest-checked, workspace-scoped, freshness-checked,
  and rejected after a referenced claim is superseded. Claim reads are batched.
- The checkpoint passes repository formatting, linting, static Effect checks, builds, package
  checks, packing validation, and 2,003 tests on the available Node 22 environment.

## Critical unfinished work

1. **Finish `GovernedActionExecutionStore.begin`.** It still needs one transaction that consumes
   the preparation token, reloads the verified aggregate, calls the strict session/target/evidence
   readers, evaluates current policy, verifies runtime authority, appends `started`, inserts the
   recovery lease, and returns a one-use permit only after commit.
2. **Finish execution outcome persistence.** Implement `recordBlocked`, `recordDispatch`,
   `recordUnknown`, `recordRecoveryUnavailable`, and `recordReconciliation` with durable provider
   inbox semantics and cancellation-safe folding.
3. **Add begin/recovery integration tests.** Cover concurrent duplicate begin, lease-write rollback,
   runtime rotation, expired preparation/authorization/session, stale preflight, missing
   `action.reconcile`, crash boundaries, unknown outcome, and restart reconciliation.
4. **Wire the execution store layer into the server composition** without exposing its internal
   capability through browser, agent, or plugin APIs.

Until these four items are complete, D03 remains incomplete and real provider mutations must stay
disabled.

## Remaining roadmap

- D04–D09: relationship repair, six-state portfolio/work views, search/traces/shares, timeline and
  exports, graceful drain, and startup reconciliation.
- I01–I12: production CodeCommit, CodePipeline, Jira, Confluence, and Clockify adapters plus sync,
  webhooks, configuration, and policy integration.
- R01–R16: finish and publish the `rly` design system, generated contract, tokens/themes,
  framework-neutral primitives, Storybook catalog, diff workbench, and agent registry.
- S01–S07: complete the full Jira, CodeCommit, Confluence, CodePipeline, and Clockify service pages,
  shared entity shell/presenters, and cross-service route-state acceptance.
- A01–A12: Effect AI-compatible local Codex/Claude wrappers, governed release-aware agents, review
  findings, and static-analysis suggestion/application flows.
- H01–H08: end-to-end hardening, documentation, changesets, final review, atomic cleanup, draft PR,
  and CI/review monitoring.

The detailed dependency order remains in `implementation-plan.md` and the milestone files under
`plan/`.

## Known non-ideal pieces

- `current-evidence.ts` uses the existing SQL adapter directly. It is intentionally isolated behind
  a private reader so it can later move to `effect-qb` without changing governed-execution callers.
- Local `effect-qb` `0.20.0` requires Effect `4.0.0-beta.98`, while this workspace and vendored
  Effect source use `beta.97`. Do not add it until the workspace, lockfile, and vendored subtree are
  aligned deliberately. Migrations, views, and triggers should remain explicit SQL.
- Evidence freshness treats `sourceObservedAt + staleAfterSeconds` as the canonical `currentUntil`.
  Add a boundary test and document the inclusive/exclusive millisecond convention before external
  adapters generate evidence references.
- Current authority corruption tests are intentionally forensic and rebuild unconstrained tables
  only inside isolated temporary databases.
- Full-suite runs occasionally expose existing timing-sensitive `live-events` tests and transient
  SQLite WAL/SHM expectations. Focused retries passed; the tests should be made deterministic rather
  than given larger timeouts blindly.
- The available runtime is Node 22 while affected packages declare Node 24 or newer. CI and final
  smoke tests must run on Node 24.
- No draft PR has been opened and nothing has been pushed from this checkpoint.

## Worktree ownership warning

The existing `ai-codex`, docs, lockfile, scratchpad, and local changeset modifications were present
outside this Control Center work and were intentionally not staged or changed. Preserve them until
their owner decides how to land them.

## Recommended next session

Start with one bounded commit implementing only the happy-path atomic `begin` transaction using
the existing private readers. Then add fail-closed branches as small test-backed commits. Run an
independent exact-commit review after each commit; turn every review finding into a regression test,
static rule, or repository instruction before proceeding.
