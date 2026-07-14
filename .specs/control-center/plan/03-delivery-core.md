# Milestone 3 — Delivery graph and work views

Goal: make relationships, evidence, readiness, and human decisions the useful center of the product before adding five production adapters.

## D01 — Persist the normalized delivery graph and evidence ledger

- **Scope:** add typed entity extensions, many-to-many relationships, lifecycle/provenance/confidence, immutable evidence claims, retention metadata, people/role assignments, and source revision supersession.
- **Tests:** graph invariants, relationship direction/cardinality, supersession without overwrite, dangling targets, evidence freshness, retention boundaries, six-item fixture.
- **Depends on:** T03, T07.
- **Review focus:** immutable attribution, no vendor shape leakage, cached invalid data cannot enter trusted collections.

## D02 — Derive environment-aware readiness incrementally

- **Scope:** add versioned readiness rules/assessments, blockers/warnings/gaps, Build/Verify/Production derivation, affected-release invalidation, and prior-assessment audit retention.
- **Tests:** all six release states, environment differences, stale/plugin-health/approval/check changes, only affected recomputation, deterministic derivation.
- **Depends on:** D01.
- **Review focus:** readiness is evidence-derived domain data, never CSS or client inference.

## D03 — Implement the governed action and audit engine

- **Scope:** add versioned action envelope, canonical payload digest/idempotency, append-only transitions, policy/permission/evidence binding, preflight, internal-only dispatch to the plugin contract's `executeAuthorizedAction`, execution receipt, cancellation/expiry, unknown outcome, and reconciliation hooks. No browser or agent API can obtain the internal execution capability.
- **Tests:** state-machine/property tests; changed digest/revision/evidence rejection; duplicate key calls the fake plugin once; denied/cancelled/expired/stale states make zero calls; crash at each transition and receipt reconciliation; actor/session/workspace isolation.
- **Depends on:** D01–D02, T04.
- **Review focus:** fail-closed policy, audit intent commits before vendor call, agent cannot authorize, ambiguity is never reported as success.

## D04 — Add relationship inspection and governed repair

- **Scope:** expose relationship/evidence API groups, candidate discovery, repair proposal/review/apply UI, exact impact/permission, lifecycle history, and semantic table fallback.
- **Tests:** inspect every field; repair one of two gaps only; stale proposal/duplicate key; readiness recomputation after second repair; audit and SSE convergence.
- **Depends on:** D01–D03, T08–T09.
- **Review focus:** staging does not mutate; unrelated releases remain byte-for-byte unchanged; confidence is explained.

## D05 — Complete the six-state portfolio filters

- **Scope:** seed all six reference releases and implement All, Need attention, Deploying, and Shipped filters with labels/counts, URL state, keyboard behavior, recoverable empty states, people/Relay/stage/gap facts, and stable selection as SSE changes membership.
- **Tests:** exact labels/counts for all six states, keyboard/filter URL/back/refresh, empty filter, live count/membership changes without focus theft, mobile/zoom, presenter derivation.
- **Depends on:** D01–D02, T07–T09.
- **Review focus:** filters are domain predicates over authoritative state, not copied display strings; live updates never leave count and rows inconsistent.

## D06 — Complete the six-item release and Active work views

- **Scope:** render all six Jira items in one card, PR grouping as a second dimension, pipeline stages as a third, people/runbook/gaps/environment, state-specific actions, and the OPS-428 review lifecycle in Active work.
- **Tests:** zero/one/six/twenty cardinality, two PR groups covering five plus one unlinked, review requested→ready persistence/restart, every object navigable, compact/mobile semantics.
- **Depends on:** D01–D05.
- **Review focus:** no Jira-board layout, no generic pipeline stream, clarity at bird's-eye and preview density.

## D07 — Add Items, search, traces, and stable authorized shares

- **Scope:** implement normalized search/filter/counts, trace-from-release/issue/PR, full-route origins, global command search, exact-scope authenticated share grants with expiry/revoke, and recoverable empty/error/not-found states.
- **Tests:** URL filter stability under SSE, direct load/back/scroll origin, grantee mismatch/expiry/revoke/deleted target, share contains no bearer session or ungranted relation.
- **Depends on:** D01–D06.
- **Review focus:** authorization at resolution time, no demo substitution, bounded search and explicit result counts.

## D08 — Add attributable Timeline and bounded exports

- **Scope:** merge human/agent/plugin/system events in stable order; actor/date filters, deep links, CSV/JSON exports, optional raw IDs/agent detail, and governed export/retention audit.
- **Tests:** same-time stable ordering, filters/deep links, escaping/content types, pagination, permission/redaction, export attribution, retention action audit.
- **Depends on:** D03–D07.
- **Review focus:** append-only source identity, no secrets/raw prompts by default, large export streaming/bounds.

## D09 — Establish graceful drain and startup reconciliation

- **Scope:** add server draining state, reject new mutations, stop sync claims/new SSE, finish short committed requests, flush audit/events/WAL, close scoped handles, expire durable claims, and reconcile fake sync/governed-action states on startup. Later subsystems must register with this same lifecycle contract when introduced.
- **Tests:** subprocess/fault injection before and after each durable boundary, hard deadline, started/unknown action reconciliation, no indefinitely running fake work, deterministic handle closure.
- **Depends on:** T08, D03, D08.
- **Review focus:** real adapters cannot land until lifecycle topology exists; interruption never becomes success and committed audit is never discarded.

## Exit gate

The payments fixture shows exactly six Jira items, two PR groupings covering five, one explicit missing relationship, a separate pipeline dimension, named people, and runbook/environment evidence. Applying two governed repairs updates only intended relationships, audits every transition, and recomputes readiness across Overview, preview, full view, Active work, Items, and Timeline without reload. A kill/restart during fake sync or action execution reaches a deterministic reconciled state.
