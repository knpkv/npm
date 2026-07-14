# Milestone 4 — Production integrations

Goal: add each capability in its owning package first, then consume it through one isolated Control Center adapter that passes the same contract suite.

Every owning-package extension below includes focused tests, supported exports, JSDoc, and its own changeset. No Control Center adapter may deep-import an unpublished module.

## I01 — Extend CodeCommit revision and changed-file reads

- **Scope:** in `@knpkv/codecommit-core`, expose immutable PR/base/head revisions, complete paginated changed-file inventory, old/new path/blob/mode/status, binary/generated/provider-limit metadata, blob reads, commit/history/comment reads, and cancellation.
- **Tests:** multi-page added/modified/deleted/renamed/binary/generated/oversized fixtures, stable IDs, tokens, limits, malformed responses, cancellation.
- **Review focus:** preserve every file and provider limit; no aggregate-count-only API; existing consumers remain compatible.

## I02 — Extend CodeCommit review and mutation primitives

- **Scope:** in `@knpkv/codecommit-core`, expose request review, comment/finding, approve/revoke/request-changes, merge strategies, and exact expected head/revision preconditions.
- **Tests:** success/conflict/permission/rate-limit/ambiguous outcome; expected revision sent on every mutation; no reuse of default-allow authorization as Control Center governance.
- **Depends on:** I01.
- **Review focus:** typed provider receipts/errors, no host-port sandbox capability exported as a security boundary.

## I03 — Add the isolated CodeCommit adapter

- **Scope:** normalize CodeCommit accounts, repositories, PRs, revisions, reviews, commits, files, checks, people, evidence, checkpoints, and action proposals into the plugin contract; implement internal authorized review/comment/approval/merge execution, provider receipts, cancellation where supported, and ambiguous-outcome reconciliation.
- **Tests:** shared adapter suite plus complete file inventory, cache replay, stale head, per-account isolation, all review/mutation preflight paths, exact-once fixture calls after durable authorization, zero calls for denial/expiry/cancel/stale payload, and receipt reconciliation.
- **Depends on:** I01–I02, D01–D03, D09.
- **Review focus:** no AWS/vendor types beyond adapter; cached reads survive provider failure; governed executor owns writes.

## I04 — Extend Jira issue/version APIs

- **Scope:** in `@knpkv/jira-api-client` and the owning higher-level package where appropriate, expose Schema-decoded changelog, custom/acceptance fields, comments/replies, transitions, users/avatars, description edits, versions, contributors, pagination, cancellation, revision/conflict and `Retry-After`; publish VersionService only through a stable tested export if reused.
- **Tests:** Cloud/server-shaped fixtures, pagination, rich content, stale edit, reply fallback model, 401/403/429/malformed/cancel; existing public compatibility.
- **Review focus:** installation-specific fields stay configured/decoded; threaded fallback is explicit Control Center behavior.

## I05 — Add the isolated Jira adapter

- **Scope:** normalize issues, releases, people, history, comments, criteria, links, revisions/evidence, and governed edit/comment/transition/link proposals; implement internal authorized execution, revision-bound receipts, cancellation where supported, and ambiguous-outcome reconciliation.
- **Tests:** shared adapter suite plus description conflict, criteria independence, reply validation, version association, partial history failure, exact-once fixture writes after authorization, zero calls for every rejection, and receipt reconciliation.
- **Depends on:** I04, D01–D03, D09.
- **Review focus:** Jira semantics preserved without making Jira records the core domain.

## I06 — Extend Confluence page/activity APIs

- **Scope:** in `@knpkv/confluence-api-client`/`@knpkv/confluence-to-markdown`, expose required page/version/content, contributors/watchers/activity, attachments/users, safe conversion, optimistic revision update/publish, pagination/cancellation and typed errors.
- **Tests:** version supersession, hostile content conversion, attachment bounds, stale update, activity pagination, partial page data.
- **Review focus:** approval/evidence stays Control Center-owned; no raw HTML or unpublished deep import.

## I07 — Add the isolated Confluence adapter

- **Scope:** normalize pages, revisions, runbook facts, people, watchers, links/evidence, activity, and governed update/publish proposals; implement internal authorized revision-bound execution, receipts, cancellation where supported, and ambiguous-outcome reconciliation.
- **Tests:** shared adapter suite plus superseded revision audit, missing attachment, stale content, safe copy payload, release/runbook relationship, exact-once fixture writes after authorization, zero calls for every rejection, and receipt reconciliation.
- **Depends on:** I06, D01–D03, D09.
- **Review focus:** current and historical content are distinguishable; unsafe media never reaches browser directly.

## I08 — Promote Clockify pagination, people, association, and rollups

- **Scope:** in `@knpkv/clockify-api-client` and, only if appropriate, `@knpkv/jira-clockify`, expose robust all-page iteration, users, entries, project/billable facts, cancellation/rate limits, and pure tested Jira-key association/rollup logic; keep credentials private to owning configuration services.
- **Tests:** zero/multi-page, overlapping contributors, inferred/unattributed entries, rollup properties, 429/cancel, stable public import.
- **Review focus:** do not export file-based credentials; association is evidence, not silent truth.

## I09 — Add the isolated Clockify adapter

- **Scope:** normalize entries/rollups, people, ticket/PR/release associations, attribution/approval evidence, freshness, and governed correction/approval proposals; implement internal authorized correction execution, receipts, cancellation where supported, and ambiguous-outcome reconciliation.
- **Tests:** shared adapter suite plus empty/inferred/unattributed/pending/approved/stale states, correction conflict, exact-once fixture writes after authorization, zero calls for every rejection, and receipt reconciliation.
- **Depends on:** I08, D01–D03, D09.
- **Review focus:** duration math and attribution deterministic; approval remains Control Center data.

## I10 — Add the isolated CodePipeline adapter

- **Scope:** use direct Schema-wrapped `distilled-aws` CodePipeline operations, adding direct CodeBuild/CloudWatch/S3 capability only when needed; normalize pipelines/executions/stages/logs/artifacts/environments/operators and governed start/stop/manual approval/retry proposals; implement internal authorized execution, provider receipts, cancellation/reconciliation. Retry starts a new execution with deterministic token and `retryOf`.
- **Tests:** shared adapter suite plus execution `#1842` retry identity, stage/log pagination, artifact proxy metadata, exact-once fixture calls only after authorization, zero calls for every rejection, ambiguity reconciliation, and deterministic token replay.
- **Depends on:** D01–D03, D09.
- **Review focus:** no credential-bearing artifact URL, no `retryStageExecution` substitution, direct dependencies only.

## I11 — Complete plugin onboarding and administration

- **Scope:** Settings lists/configures/enables/disables all five adapters, validates non-secret endpoint/workspace/profile references resolved through T04's SecretStore, displays capability/contract/health/freshness/diagnostics, controls adapter permissions, and supports fresh-install onboarding.
- **Tests:** configure one fake then every adapter fixture, revision conflicts, enable/disable isolation, health refresh, secret-canary browser/API/storage scan, fresh-install browser journey.
- **Depends on:** I03, I05, I07, I09–I10.
- **Review focus:** partial failure never blocks unrelated pages; secrets are references only; actionable diagnostics remain redacted.

## I12 — Complete concurrency-safe workspace settings

- **Scope:** add versioned Schema-decoded settings API/read model/UI for relationship inference, sync cadence, evidence/content/audit/agent/sandbox retention, failure investigation, Jira comment behavior, pipeline retry policy, agent provider/model/tool/profile policy, and presentation preferences. Shared values use revision/ETag compare-and-swap; governed policy/retention changes use D03. Theme has a persistent desktop/mobile control with system/light/dark and remains the only allowed browser-local presentation preference where appropriate.
- **Tests:** dirty→saving→saved, validation, server failure/retry, stale concurrent conflict with recover/reapply, two-session convergence, theme system/light/dark on desktop/mobile, governed policy/retention denial and audit, restart persistence, no secret values in settings.
- **Depends on:** D03, D08–D09, I11.
- **Review focus:** plugin configuration and workspace policy remain distinct; no silent last-write-wins, page reload requirement, or browser-owned shared policy.

## Exit gate

Run the same adapter contract suite against all five implementations. For each, prove timeout, 401/403, 429 with retry time, malformed payload, outage, cancellation, checkpoint replay, last-valid-cache retention, authorized exact-once fixture execution, zero calls for every rejected action, truthful receipt reconciliation, and recovery without duplicate events. Then complete fresh-install onboarding and concurrency-safe workspace settings through typed APIs.
