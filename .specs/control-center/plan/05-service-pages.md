# Milestone 5 — Full service experiences

Goal: expose every actionable provider entity through the same calm, human-centric shell while retaining its useful native detail.

## S01 — Add shared entity read models, presenters, and shell routing

- **Scope:** expose canonical entity API/read model, presenters, `EntityShell` route composition, service provenance, verdict/freshness, people/roles, relationship chain/table, contextual agent entry, governed-action slots, activity, origin/back/refresh, and complete data-state panels.
- **Tests:** presenter boundary/property tests and page contract tests for every service and loading/empty/stale/partial/error/unavailable/not-found state.
- **Depends on:** D01–D09, I03/I05/I07/I09/I10, I12.
- **Review focus:** service pages reuse rly patterns; vendor records do not leak; every related object opens canonical full view.

## S02 — Build the full Jira issue experience

- **Scope:** fields, assignee/owner, priority/estimate/release, rich description edit/cancel/save, independently toggled criteria, comments/replies/composer, human/sync history, delivery evidence, and governed transition/link/approval.
- **Tests:** save/cancel, validation, stale concurrent edit recovery, criteria independence, reply/history persistence, permission denial zero call, refresh/back/context.
- **Depends on:** S01, I05.
- **Review focus:** normal Jira information is complete without recreating a Jira board; history and audit attribution remain distinct.

## S03 — Build the CodeCommit PR overview and review experience

- **Scope:** author/branches/head, summary, commits/checks, reviewers/approvers, review lifecycle, Jira/pipeline/release evidence, request-review/request-changes/approve/revoke and governed merge-capable actions; reserve the Files data and route integration for A01–A02.
- **Tests:** immutable-head display, reviewer/approver roles, review lifecycle persistence/staleness, action preflight/conflict, canonical navigation.
- **Depends on:** S01, I03.
- **Review focus:** human decisions never collapse into agent recommendation; no legacy sandbox UI import.

## S04 — Build the full Confluence page experience

- **Scope:** safe readable content, scope/prerequisites/commands/copy, revision/activity history, owner/contributors/approver/watchers, related evidence, freshness, governed update/publish, superseded revision access.
- **Tests:** content sanitization, copy semantics, stale update, history/audit, role labels, attachment/unavailable states, refresh/back/context.
- **Depends on:** S01, I07.
- **Review focus:** readable runbook first, unsafe HTML/media excluded, approval is explicit evidence.

## S05 — Build the full CodePipeline execution experience

- **Scope:** pipeline/execution/trigger/revision/artifact/target/duration, compact stage rail, bounded logs, verified artifact proxy, environment/rollout, operators/approver, PR/release/runbook, governed retry/start-deploy/watch.
- **Tests:** failed `#1842` retry creates a distinct linked execution, repeated submit once, logs/artifact bounds, stage partial failure, history preserved.
- **Depends on:** S01, I10.
- **Review focus:** no useless generic “live stream” panel; page answers what is running, where, why, by whom, and what can be done.

## S06 — Build the full Clockify experience

- **Scope:** entries/rollups, duration/date/project/billable facts, contributors/approvers, ticket/PR/release associations, evidence/attribution, activity, and governed correction/approval.
- **Tests:** empty/inferred/unattributed/pending/approved/stale/error matrices, rollup totals, correction conflict, people roles, refresh/back/context.
- **Depends on:** S01, I09.
- **Review focus:** provenance and missing attribution are obvious without visual noise.

## S07 — Complete cross-service navigation and route-state acceptance

- **Scope:** finish service-aware command search, Release→Jira→PR traces, exact origin restoration from Overview/preview/Active work/Items/Timeline/share, reasonable scroll restoration, and contextual relationship previews.
- **Tests:** direct-load/refresh/back journeys for every service, removed resources, concurrent SSE updates, mobile keyboard navigation, no default-entity substitution.
- **Depends on:** S02–S06.
- **Review focus:** navigation feels like one product, not five embedded UIs; short identifiers never replace full accessible names.

## Exit gate

Load each canonical service URL from typed durable APIs, exercise at least one governed action through proposal → authorization → fixture-provider execution → durable receipt, prove one rejected action makes zero provider calls, navigate its relationships and people, refresh, and return to the exact origin. Run the shared entity state matrix and confirm no page imports prototype runtime or duplicates a covered rly primitive. No live vendor endpoint is used by acceptance tests.
