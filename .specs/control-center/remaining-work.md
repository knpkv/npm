# Control Center — remaining work

## Baseline

This specification starts after the verified-provider ownership work in PR #190. The repository
already has the reusable `@knpkv/rly` design system, authenticated local server, unstable exact
schema snapshot, delivery graph and readiness model, governed relationship repair, release and work
views, Items, Timeline, bounded shares, graceful-drain foundation, read-only production adapters,
shared AWS profile discovery, preferred Atlassian OAuth, live connection tests, and account/resource
ownership.

The remaining goal is to turn those foundations into a useful real-data product without waiting for
complete native-service parity. Each item below is a small independently reviewable slice intended
to land as one commit in the implementation plan's reviewed series. No slice is an independently
mergeable PR: the completed series follows H08's single draft-PR and release-gate protocol. Each
slice must leave an explicit extension seam and must not advertise capabilities that are still absent.

## Delivery rules

- Prefer a thin end-to-end journey over a broad provider abstraction. Ship one visible result per
  slice/commit in the reviewed series.
- Keep provider credentials and types behind the existing adapter and `SecretStore` boundaries.
- All provider writes go through the existing governed-action authority, idempotency, receipt, and
  reconciliation path. Agents may propose actions but never authorize them.
- Use the existing exact unstable schema snapshot. Do not add migrations until a released database
  must remain readable by a newer build.
- Run focused deterministic gates first, then one consolidated exact-diff review. Merge only when
  exact-head CI is green, Codex reports no major issue, and no review thread remains unresolved.
- Add a reusable static rule only for a recurring, high-impact, mechanically enforceable defect
  class. Behavioral provider and lifecycle invariants belong in tests.

## Current status

| Area                                    | Status        | Remaining boundary                                                                                                                  |
| --------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| R01–R16 repository and `rly`            | Complete      | Maintenance only                                                                                                                    |
| T01–T12 authenticated tracer foundation | Complete MVP  | Extend its security and recovery suites with each new route                                                                         |
| D01–D09 delivery core                   | Complete MVP  | Replace fixture-only facts with synchronized provider facts                                                                         |
| I01/I03 CodeCommit                      | Partial       | Read/sync/inventory exist; complete diff content, reviews, checks, history, and governed writes do not                              |
| I04/I05 Jira                            | Partial       | Bounded issue detail exists; project sync and governed edits/comments/transitions do not                                            |
| I06/I07 Confluence                      | Partial       | Bounded page detail exists; space sync, activity, and governed update/publish do not                                                |
| I08/I09 Clockify                        | Partial       | Bounded time-entry read/sync exists; people, Jira association, rollups, correction, and approval do not                             |
| I10 CodePipeline                        | Partial       | Bounded execution sync exists; logs, artifact proxy, retry/deploy actions, and reconciliation do not                                |
| I11 provider administration             | MVP           | Connection ownership/setup is usable; sync controls, recovery, permissions, and richer account editing remain                       |
| I12 workspace settings                  | Not delivered | Durable concurrency-safe settings and policy UI remain                                                                              |
| S01–S07 service experiences             | Not delivered | There are no canonical production entity pages yet                                                                                  |
| A01–A12 agents and diffs                | Partial       | `rly` diff UI and local CLI providers exist; durable jobs, threads, app diff data, sandbox review, and human disposition remain     |
| H01–H08 hardening                       | Partial       | Shared drain/startup foundations exist; final subsystem, security, accessibility, performance, operations, and release gates remain |

## Ordered implementation slices

### M1 — Make connected services produce visible real data

#### M1.1 — Add manual synchronization

- Add an owner-only **Sync now** action and last-attempt/last-success/result state to each connection
  that already negotiates synchronization: CodeCommit, CodePipeline, and Clockify.
- Add the production materialization path from decoded `NormalizedPluginEventV1` pages into the
  canonical delivery-graph/entity repositories. Apply `UpsertEntity`, `TombstoneEntity`,
  `AppendEvidence`, `UpsertPerson`, and `ProposeRelationship` with host-assigned scope, stable
  identities, and replay-safe semantics. A durable plugin cache page or checkpoint without its
  durable normalized projections is not a successful synchronization result.
- Reuse the existing connection runtime, bounded checkpoint transaction, Timeline event, and
  invalidation path. Do not introduce a scheduler or webhook.
- **Acceptance:** exercise CodeCommit, CodePipeline, and Clockify fixture connections separately
  through the owner-only, CSRF-protected action. Each produces its own normalized Item—a pull request,
  pipeline execution, or time entry respectively—and an attributed plugin-sync Timeline event;
  replaying its completed checkpoint duplicates neither projections nor events. The application
  materialization suite covers all five normalized event operations and proves Items reads from the
  resulting current projections rather than from plugin-cache pages alone.

#### M1.2 — Add bounded Jira project synchronization

- Extend the owning Jira package with bounded, cancellable project issue iteration, then negotiate
  incremental synchronization in the Jira adapter.
- As soon as the adapter negotiates synchronization, expose the same owner-only, CSRF-protected
  **Sync now** application and UI boundary, result state, and invalidation contract as M1.1. Do not
  defer reachability to scheduled synchronization or provider administration.
- Materialize issues, versions, people, comments/history freshness, and fix-version release evidence.
- **Acceptance:** an owner follows one Jira project, invokes **Sync now**, and sees Items and a release
  populate without entering an issue key manually; another project on the same OAuth site stays
  isolated. The owner flow covers the shared mutation security boundary and bounded completion state.

#### M1.3 — Add bounded Confluence space synchronization

- Extend the owning Confluence packages with bounded, cancellable space page/activity iteration,
  then negotiate synchronization in the Confluence adapter.
- As soon as the adapter negotiates synchronization, expose the same owner-only, CSRF-protected
  **Sync now** application and UI boundary, result state, and invalidation contract as M1.1. Do not
  defer reachability to scheduled synchronization or provider administration.
- Materialize pages, revisions, owners/contributors/watchers, attachments metadata, and safe runbook
  evidence. Content remains lazy and bounded.
- **Acceptance:** an owner follows one Confluence space, invokes **Sync now**, and sees Items and
  runbook candidates populate while another space on the same OAuth site stays isolated. The owner
  flow covers the shared mutation security boundary and bounded completion state.

#### M1.4 — Infer cross-service relationship candidates

- Derive evidence-backed candidates from Jira fix versions, Jira keys in PR metadata, immutable
  CodeCommit revisions observed by CodePipeline, Confluence links, and Clockify descriptions.
- Persist evidence and candidate confidence; do not silently turn inferred links into verified
  truth. Reuse governed relationship repair for confirmation.
- **Acceptance:** synchronized Jira → PR → pipeline → release and runbook/time candidates appear in
  the existing release workset, with missing and inferred edges visibly distinct.

### M2 — Add canonical, read-first service pages

#### M2.1 — Add the shared entity route and shell

- Add one canonical workspace entity route backed by a typed server read model. It owns origin/back
  state, loading/empty/stale/partial/error/not-found states, provenance, freshness, collaborators,
  relationship chain/table, activity, and contextual agent entry.
- The shell selects a service-specific presenter; it does not expose vendor response types or move
  domain decisions into `rly`.
- **Acceptance:** every item and related object opens a full page by default, refreshes safely, and
  returns to its exact Overview/preview/Active work/Items/Timeline origin.

#### M2.2 — Jira issue page

- Show normal issue fields, rich description, acceptance criteria, release, assignee/owner,
  collaborators, comments, changelog, delivery evidence, and explicit truncation/freshness.
- Keep it read-only in this slice.
- **Acceptance:** a real synchronized issue shows the complete bounded Jira reader result and all
  related objects remain navigable.

#### M2.3 — CodeCommit pull-request page

- Show immutable head/base, author, branches, summary, commits/checks when available,
  reviewers/approvers, review state, Jira/release/pipeline evidence, and a Files entry point.
- Keep provider review decisions read-only in this slice.
- **Acceptance:** the displayed head is the same revision used by relationships and future diff
  reads; agent recommendation is visually and semantically separate from human approval.

#### M2.4 — CodePipeline execution page

- Show pipeline/execution identity, trigger/revision, target environment, duration, compact stages,
  operators/approver, bounded action detail, artifacts marked proxy-required, and related objects.
- Do not add a generic live-stream panel or expose provider artifact URLs.
- **Acceptance:** the page answers what ran, where, why, by whom, and which release/PR/runbook it used.

#### M2.5 — Confluence page

- Show safely converted content, revision, owner/contributors/watchers, activity, attachments state,
  freshness, runbook evidence, and supersession.
- Keep update/publish read-only in this slice.
- **Acceptance:** hostile content and media cannot execute or bypass the authenticated media boundary.

#### M2.6 — Clockify page

- Show entries and deterministic rollups, project/billable facts, contributors/approvers,
  inferred/unattributed Jira associations, evidence, freshness, and activity.
- Keep corrections and approval read-only in this slice.
- **Acceptance:** totals are deterministic and missing attribution is obvious without hiding entries.

#### M2.7 — Finish cross-service navigation

- Make command search and every release relationship open canonical entity pages; preserve exact
  origin, selected relationship, and reasonable scroll state across direct load, refresh, and Back.
- **Acceptance:** Release → Jira → PR → pipeline → runbook and the reverse journey behave like one
  product, including removed/stale resources and narrow layouts.

### M3 — Add governed human actions one provider at a time

#### M3.1 — CodeCommit review actions

- Finish owning-package review/comment/approve/request-changes/merge primitives with immutable-head
  preconditions, then expose proposals and internal execution through the adapter.
- **Acceptance:** request review, approve, and request changes have durable receipts; stale or denied
  actions make zero provider calls, and ambiguous outcomes reconcile without replay.

#### M3.2 — Jira actions

- Add description edits, comments/replies, transitions, and link/version association with revision
  preconditions and explicit threaded-comment fallback.
- **Acceptance:** conflict recovery preserves the human draft; authorization, expiry, and stale
  evidence failures make zero provider calls.

#### M3.3 — Confluence actions

- Add optimistic page update/publish with safe content conversion, revision-bound receipts, and
  reconciliation.
- **Acceptance:** a superseded revision never overwrites newer content and historical evidence remains
  attributable.

#### M3.4 — CodePipeline actions

- Add bounded logs and authenticated artifact proxy first, then governed start/stop/manual approval
  and retry. Retry creates a distinct execution linked by `retryOf` and a deterministic token.
- **Acceptance:** repeated retry submission starts exactly one new execution; credentials never enter
  logs, artifact URLs, API responses, or browser state.

#### M3.5 — Clockify correction and approval

- Add deterministic association correction and approval proposals, provider correction where the API
  supports it, receipts, and reconciliation.
- **Acceptance:** corrected rollups converge without rewriting original evidence, and Control Center
  approval remains distinct from provider entry state.

### M4 — Make the agent durable and useful

#### M4.1 — Connect complete PR diff data

- Finish complete CodeCommit inventory/content/range reads, content-addressed caching, stable anchors,
  and authenticated bounded APIs; connect them to the existing `rly` diff workbench.
- **Acceptance:** a 500-file PR lists every file before reporting ready, lazily renders supported
  content, marks unavailable/binary/generated/oversized states, and survives worker failure.

#### M4.2 — Add durable jobs and release threads

- Persist job/attempt/lease/event/output state and one thread per workspace/release. Add transactional
  claims, cancellation, restart reclaim, bounded output, context snapshots, and a deterministic fake
  agent/provider contract.
- **Acceptance:** closing the browser does not stop a job; reconnect/restart resumes one ordered thread
  without duplicating a claim or crossing release/workspace context.

#### M4.3 — Administer agent providers

- Register `@knpkv/ai-codex`, `@knpkv/ai-claude`, and one OpenAI-compatible Effect AI provider behind
  a server-only registry with persisted provider/model/safe-profile selection and redacted health.
- **Acceptance:** routing is explicit, unavailable providers fail closed, and no environment,
  credential, command, or raw provider type reaches browser or SQL.

#### M4.4 — Add sandboxed PR review and static-analysis suggestions

- Run immutable-head checkout and analysis in a non-root, read-only, networkless, quota-bound sandbox;
  validate and persist findings against stable diff anchors.
- Present the agent recommendation separately from human approve/request-changes disposition. A review
  may propose an ESLint/ast-grep/test/instruction prevention change, but applying it is a separately
  reviewed governed proposal.
- **Acceptance:** cancellation/restart cleans or reconciles the sandbox, hostile paths/output are
  rejected, the agent cannot authorize provider writes, and a recurring mechanical finding can land
  with reject/allow guardrail fixtures.

### M5 — Complete administration and operations

#### M5.1 — Finish provider administration

- Add profile reauthorization/revocation/expired-token recovery, account-level editing, richer
  provider resource pickers, per-connection permissions, sync status/schedule, health/freshness, and
  diagnostics. Keep machine-local profiles separate from persisted provider identity.
- Preserve the current partial-success batch behavior; atomic multi-resource setup remains deferred
  until it has a clear rollback contract.

#### M5.2 — Add concurrency-safe workspace settings

- Add revision/ETag-protected settings for inference, sync cadence, retention, investigation, Jira
  comment behavior, pipeline retry policy, agent provider/model/tool/profile policy, and presentation.
- Govern policy and retention changes through the existing action/audit boundary. Theme remains the
  only browser-local shared-preference exception where appropriate.

#### M5.3 — Extend lifecycle, backup, retention, and recovery

- Register every real adapter, provider stream, durable agent job, child process, and sandbox with the
  shared drain/startup contract; finish backup/restore integrity, quarantine, WAL, and bounded
  retention operations for final durable classes.
- **Acceptance:** kill/restart at each durable boundary cannot lose committed audit, duplicate an
  ambiguous provider mutation, or leave work indefinitely running.

#### M5.4 — Finish security, accessibility, and performance gates

- Complete hostile web/LAN/content/secret tests, second-machine HTTPS operating test, all-route
  keyboard/reflow/forced-color/reduced-motion coverage, and the documented large-fixture benchmark.
- Profile declaration/distribution validation and avoid rebuilding unchanged dependencies in local
  browser workflows; do not weaken correctness bounds to improve timings.

#### M5.5 — Finish documentation and retire prototype runtime

- Reconcile the docs site for Control Center, `rly`, local AI providers, provider setup, OAuth,
  operations, governance, sandboxing, and troubleshooting. Publish/link Storybook.
- Remove prototype-only runtime routes/imports after parity evidence while retaining approved visual
  fixtures as non-runtime references.

#### M5.6 — Run the release gate

- Complete changesets, requirement traceability, frozen install, all repository/package/browser/
  security/containment/benchmark/docs gates, deliberate local Codex smoke, exact-head review, and
  process/container cleanup.
- **Acceptance:** every SC7.1–SC7.25 criterion has linked evidence and the product completes the real
  end-to-end journey below.

## Product completion journey

From a fresh local installation, an owner pairs a browser, connects one AWS account and one Atlassian
site, follows multiple repositories/pipelines/projects/spaces, synchronizes real data, and sees a
release composed from six Jira items, PRs, pipeline execution, runbook, collaborators, evidence, and
gaps. Every object opens a canonical full page. A human can repair a relationship and perform at least
one governed action per provider with durable receipt/reconciliation. A release-scoped agent survives
browser closure, reviews an immutable PR in a contained sandbox, reports anchored findings, proposes
prevention, and remains separate from the final human decision. Restart, partial provider failure,
dark/light/narrow/keyboard use, and a second-machine HTTPS session preserve truthful state without
exposing credentials.

## Explicitly deferred beyond this plan

- Atomic all-or-nothing multi-resource connection setup.
- Webhooks and near-real-time provider ingestion; bounded manual/scheduled sync is sufficient.
- Complete Jira/Confluence/CodeCommit native UI parity or embedded provider applications.
- Provider-specific full-text indexes before measured scale requires them.
- Versioned database migrations before schema stability and a released compatibility obligation.
- Package publication or deployment; those require separate authorization after the release gate.
