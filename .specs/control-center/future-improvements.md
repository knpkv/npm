# Control Center — future improvements after the authority checkpoint

This document records the deliberate cutoff made on 2026-07-15. The repository is left at a
tested, resumable checkpoint; the larger implementation roadmap is **not** being represented as
complete.

## Safe checkpoint delivered

- Runtime authority is persisted, derived from canonical runtime inputs, generation-bound, and
  revalidated before and after transaction callbacks.
- Runtime generations are retained so an `A → B → A` rotation cannot revive an old token.
- Governed execution inspection issues only short-lived preparation capabilities.
- Governed execution `begin` now consumes an exact workspace-scoped preparation inside the
  runtime-authority transaction, revalidates current session/target/evidence/policy, appends the
  start intent and lease atomically, and returns a one-use permit only after commit.
- Execution `begin` now receives the exact inspected workspace/connection scope, and the engine
  rejects cross-wired permits before calling a provider.
- Governed `recordBlocked` atomically commits preflight denial and consumes its preparation without
  calling a provider. `recordDispatch` and `recordUnknown` persist through cancellation-safe
  append-before-fold boundaries, including persisted-only restart folding.
- Expired execution leases now issue one recovery claim at a time, with the provider deadline
  strictly inside the claim lease so durable receipt persistence retains a bounded margin.
  Reconciliation pending, succeeded, failed, cancelled, and timestamped
  runtime-generation-unavailable outcomes share one canonical fold engine, exact replay checks, and
  persisted-only restart recovery with dispatch outcomes.
- Private strict readers load current session, target, projection, and evidence authority without
  falling back to older valid records.
- Referenced evidence items and claims are digest-checked, workspace-scoped, freshness-checked,
  and rejected after a referenced claim is superseded. Claim reads are batched.
- The checkpoint passes repository formatting, linting, static Effect checks, builds, package
  checks, and packing validation. The complete Control Center suite passes on Node 24 with 97 test
  files and 875 tests; PR-wide verification remains authoritative for the integrated workspace.

## Critical unfinished work

1. **Complete the begin/recovery failure matrix.** The real-database happy path, one-use replay,
   reconciliation deadline, changed recovery replay, and reconciliation restart fold are covered.
   Still add concurrent duplicate begin, lease-write rollback,
   runtime rotation, expired preparation/authorization/session, stale preflight, missing
   `action.reconcile`, and the full cancellation-versus-reconciliation race matrix.
2. **Wire the execution store layer into the server composition** without exposing its internal
   capability through browser, agent, or plugin APIs.

Until these two items are complete, D03 remains incomplete and real provider mutations must stay
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
- `begin.ts` deliberately maps the canonical runtime-authority token into the governed connection
  authority digest because both represent the same non-secret configured runtime generation. This
  should become one shared nominal domain type when the proposal API is implemented, avoiding the
  explicit schema-brand conversion at the execution boundary.
- Local `effect-qb` `0.20.0` requires Effect `4.0.0-beta.98`, while this workspace and vendored
  Effect source use `beta.97`. Do not add it until the workspace, lockfile, and vendored subtree are
  aligned deliberately. Migrations, views, and triggers should remain explicit SQL.
- Evidence freshness treats `sourceObservedAt + staleAfterSeconds` as the canonical `currentUntil`.
  Add a boundary test and document the inclusive/exclusive millisecond convention before external
  adapters generate evidence references.
- Current authority corruption tests are intentionally forensic and rebuild unconstrained tables
  only inside isolated temporary databases.
- The 512/513-event live-stream boundary fixtures now prepare their journal in one outer database
  transaction and retain Vitest's normal timeout. Transient SQLite WAL/SHM expectations outside
  that fixture still warrant care in future persistence tests.
- The interactive shell exposes Node 24, but its installed `pnpm` launcher is backed by Node 22.
  Direct local validation therefore invokes test tools with Node 24; PR CI remains the authoritative
  Node 24 workspace check.
- `governedActionExecutionBegin.test.ts` now holds the end-to-end persistence fixtures for begin,
  dispatch, unknown, recovery claims, and reconciliation. Split the shared fixture and outcome
  matrices into focused files after D03 is wired; keeping one database harness avoided duplicating
  security-sensitive setup during this checkpoint.
- Draft PR #126 is open from `feature/control-center`. Keep it in draft while the critical D03 work
  above remains unfinished and real provider mutations remain disabled.

## Worktree ownership warning

The existing `ai-codex`, docs, lockfile, scratchpad, and local changeset modifications were present
outside this Control Center work and were intentionally not staged or changed. Preserve them until
their owner decides how to land them.

## Recommended next session

Continue with the private execution-store/engine server composition, then close the highest-value
begin/recovery failure cases. Run an independent exact-commit review after each commit; turn every
review finding into a regression test, static rule, or repository instruction before proceeding.
