# Agentic pull-request review implementation plan

## Baseline

Plan against `origin/main` at `da998ad90` or a newer main revision, not the current stale worktree branch. Latest main already contains:

- Durable provider-neutral `@knpkv/ai-runtime`.
- Local Codex and Claude Effect AI adapters.
- Durable agent jobs, leases, cancellation, events, worker startup, and persisted review reports.
- Exact CodeCommit source acquisition and a hardened bounded review container.
- CodeCommit review-action preflight, idempotency markers, receipts, and reconciliation.
- Complete pull-request diff reads and a basic review panel.
- Rly/Pierre complete diff rendering and workbench primitives.

The implementation replaces the bounded analyzer/report path without migration. It should deepen existing modules rather than build parallel infrastructure.

## Delivery rules

- Start a fresh branch from current main and carry the approved specification, glossary, and ADRs onto it.
- Keep each pull request independently buildable and testable.
- Add package changesets with the pull request that changes each published package.
- Run deterministic package gates before one consolidated review pass.
- Merge only after required checks pass and external Codex review reports no major issue.
- Run the full repository gate once in the final milestone rather than after every internal finding.

## PR 1 — Deepen `@knpkv/ai-runtime` with a structured tool loop

### Goal

Add a stateless tool-loop module behind the existing provider-neutral runtime seam. Do not create `@knpkv/ai-agent`.

### Changes

- Add a tool definition model with:
  - Stable tool name and description.
  - Schema-decoded input.
  - Schema-encoded bounded result.
  - Typed execution failure.
- Add one primary tool-agent run interface that accepts:
  - Instructions.
  - Structured context.
  - Effect AI LanguageModel.
  - Tool registry.
  - Final output schema.
  - Time budget and cancellation.
- Stream typed events for:
  - Run start.
  - Model progress.
  - Tool requested.
  - Tool completed or failed.
  - Usage.
  - Output validated.
  - Terminal outcome.
- Bound model-visible tool results to 64 KiB.
- Return head/tail excerpts and an opaque artifact ID when truncated.
- Allow the caller to provide artifact paging and search tools.
- Feed schema errors back to the model once; fail the second invalid response.
- Provide an adapter that exposes the tool loop through the existing `AgentRuntimeService`, preserving durable-job integration.
- Keep thread persistence, Docker, review vocabulary, and provider selection outside this package.

### Likely paths

- `packages/ai-runtime/src/tool.ts`
- `packages/ai-runtime/src/toolLoop.ts`
- `packages/ai-runtime/src/model.ts`
- `packages/ai-runtime/src/runtime.ts`
- `packages/ai-runtime/src/fake.ts`
- `packages/ai-runtime/src/index.ts`
- `packages/ai-runtime/test/tool-loop.test.ts`
- `packages/ai-runtime/README.md`
- `packages/docs/src/content/docs/ai-runtime.mdx`

### Tests

- Multi-turn tool selection and final structured output.
- Unknown tool and malformed tool input.
- One successful schema repair.
- Second invalid response fails without coercion.
- 64 KiB truncation, artifact paging, and artifact search.
- Tool failure returned to the model without becoming an untyped defect.
- Cancellation interrupts the active model or tool effect.
- Budget expiration returns a typed timeout.
- Existing release-chat runtime tests remain unchanged.

### Exit gate

`@knpkv/ai-runtime` tests, check, lint, build, packed contract, docs, and changeset pass.

## PR 2 — Refactor exact checkout and add the hardened Review Sandbox session

### Goal

Reuse the existing exact CodeCommit source and Docker mechanisms while replacing static-analyzer-only execution with an ephemeral writable project session controlled through typed tools.

### Changes in `@knpkv/codecommit-core`

- Extract reusable low-level mechanisms from the interactive SandboxService:
  - Authenticated host checkout.
  - Exact commit verification.
  - Container create/inspect/exec/stop/remove.
  - Label-based reconciliation.
- Keep interactive code-server sandbox policy behavior unchanged.
- Extend exact checkout inputs to require both expected base and head commit IDs.
- Strip authenticated remotes and credential configuration before handoff.
- Copy the verified checkout into an isolated Docker volume instead of bind-mounting the host staging directory.
- Delete staging data after successful handoff and on every failure path.

### Changes in Control Center

- Replace the one-shot static analyzer interface in `PrReviewSandboxRunner` with a Review Sandbox session interface:
  - Open exact revision.
  - Read/list/search files.
  - Execute arbitrary sandbox shell commands.
  - Apply temporary patches.
  - Read temporary `git diff`.
  - Page/search retained command artifacts.
  - Close and destroy.
- Preserve existing hardening:
  - Digest-pinned runner image.
  - Non-root user.
  - No network by default.
  - No Docker socket.
  - No host mounts or exposed ports.
  - No inherited environment or credentials.
  - Bounded output and process duration.
  - Container labels and startup reconciliation.
- Add explicit unauthenticated endpoint allowlists without introducing credential injection.
- Load executable repository instructions from the base revision only.
- Remove the two-minute/one-shot analyzer assumption; accept the per-run Review Budget.
- Destroy the container and Docker volume when the run terminates.

### Likely paths

- `packages/codecommit-core/src/CheckoutService/*`
- `packages/codecommit-core/src/SandboxService/DockerService.ts`
- `packages/codecommit-core/src/SandboxService/SandboxService.ts`
- `packages/codecommit-core/test/CheckoutService.test.ts`
- `packages/control-center/src/server/agent/internal/PrReviewSourceWorkspace.ts`
- `packages/control-center/src/server/agent/internal/PrReviewSandboxRunner.ts`
- `packages/control-center/src/server/agent/internal/PrReviewWorkspaceProtocol.ts`
- `packages/control-center/test/agent/pr-review-source-workspace.test.ts`
- `packages/control-center/test/agent/pr-review-sandbox-runner.test.ts`

### Tests

- Local fixture repository produces exact base/head checkout.
- Branch movement after enqueue cannot change the reviewed head.
- Credentials and authenticated remotes are absent inside Docker.
- Host staging path is not mounted in the container.
- Workspace is writable inside the volume.
- Network, Docker socket, host paths, and environment inheritance remain blocked.
- Commands, tests, temporary edits, and diff inspection work.
- Cancellation and timeout kill child processes and clean resources.
- Restart reconciliation finds labeled live containers.
- Failure paths delete staging directories and volumes.

### Exit gate

CodeCommit Core and Control Center targeted sandbox tests, checks, lint, build, docs, and changesets pass.

### Implemented shape

The session is additive until PR 4 switches durable orchestration away from
the pre-stable one-shot runner. `PrReviewSandboxSessions` owns exact-source
handoff, the named-volume/container scope, typed sandbox tools, bounded local
artifacts, timeout cleanup, and label reconciliation. The exact-source broker
now removes authenticated remotes and authority-bearing local Git
configuration before handoff. The Docker integration test pulls a trusted
digest-pinned runner when Docker is available and proves the policy against a
local Git fixture without AWS or agent-provider credentials.

## PR 3 — Replace the review domain and persistence model

### Goal

Replace the capped file-finding report with durable Review Threads, immutable runs, structured suggestions, notes, revisions, transitions, evidence, and publications.

### Domain changes

- Remove:
  - `MAXIMUM_PR_REVIEW_FINDINGS`.
  - `PrReviewAgentRecommendation`.
  - File-only finding schema.
  - Model-authored stable finding IDs.
- Add schemas for:
  - Review Thread identity per CodeCommit pull request.
  - Review Run and Review Run Status.
  - Review Context Snapshot.
  - Suggestion Anchor union: line, file, changes.
  - Related Location.
  - Review Evidence.
  - Confidence and reason.
  - P1–P4 Suggestion Severity.
  - Unified-diff Suggested Replacement.
  - Optional Prevention Proposal.
  - Review Suggestion and immutable Suggestion Revision.
  - Review Note.
  - Suggestion transitions: still-present, resolved, reopened, new.
  - Dismissal reason.
  - Publication snapshot and CodeCommit receipt.
  - Coverage and limitation records.
  - Derived Review State.
- Assign new stable suggestion IDs in Control Center with UUIDv7.
- Validate all agent-referenced prior IDs during reconciliation.
- Keep per-field and per-event bounds, but remove the suggestion-count cap.

### Persistence changes

- Keep generic job/lease/attempt machinery in `agentJobRepository`.
- Add a dedicated PR-review repository rather than growing the 1,400-line agent-job repository.
- Add typed `effect-qb` plans in `@knpkv/control-center-sql` for:
  - Thread by pull-request identity.
  - Run insertion and status transition.
  - Current suggestion projection.
  - Suggestion revision history.
  - Run-to-run reconciliation.
  - Thread timeline pagination.
  - Publication lookup.
  - Retention candidates.
- Update the current schema directly; add no migration compatibility.
- Keep Schema decoding and transaction invariants at the repository seam.
- Store large command output in the existing content/blob store, referenced by digest.

### Likely paths

- `packages/control-center/src/domain/prReview.ts`
- `packages/control-center/test/domain/prReview.test.ts`
- `packages/control-center/src/server/persistence/repositories/prReviewModels.ts`
- `packages/control-center/src/server/persistence/repositories/prReviewRepository.ts`
- `packages/control-center/src/server/persistence/repositories/index.ts`
- `packages/control-center/src/server/persistence/schema.json`
- `packages/control-center/src/server/persistence/schemas.ts`
- `packages/control-center/test/persistence/pr-review-repository.test.ts`
- `packages/control-center-sql/src/prReviews.ts`
- `packages/control-center-sql/src/index.ts`
- `packages/control-center-sql/test/pr-reviews-query.test.ts`

### Tests

- Every legal lifecycle transition.
- Rejected stale publication.
- Agent resolution without human confirmation.
- Dismissal reasons and evidence-based reopening.
- Stable-ID reconciliation after moved lines.
- Duplicate and unknown transition IDs rejected transactionally.
- Published snapshots do not change when drafts are edited.
- Unlimited paginated suggestion count.
- Malformed persisted records fail closed.
- `effect-qb` plans render stable SQL and parameters.

### Exit gate

Domain, persistence, Control Center SQL, schema, package-contract, check, lint, and changeset gates pass.

## PR 4 — Connect the tool agent to durable PR-review orchestration

### Goal

Replace `PrReviewTaskExecutor`'s bounded-evidence prompt with full sandbox exploration while preserving durable jobs, leases, cancellation, and worker recovery.

### Changes

- Refactor `AgentRuntimeRegistry` so PR review selects:
  - Explicit provider and model.
  - The matching Effect AI LanguageModel.
  - The `@knpkv/ai-runtime` tool-loop adapter.
  - No silent provider fallback.
- Keep release chat on its existing simple runtime path.
- Build the Review Instruction Set from:
  - Local review policy.
  - Base-revision repository instructions.
  - Exact PR subject.
  - Review Context Snapshot.
- Expose only typed Review Sandbox tools to the loop.
- Stream sanitized tool events into the durable run timeline.
- Validate the final suggestion/note/reconciliation schema.
- Derive Review State in application code rather than accepting a model verdict.
- Add explicit application commands:
  - Start Full review.
  - Re-review current head.
  - Revalidate one suggestion.
  - Targeted thread request.
  - Edit draft.
  - Resolve.
  - Dismiss.
- Remove the current requirement that a PR must have a canonical release before it can be reviewed.
- Remove workspace-owner gating for the local single-operator product.
- Allow validated partial suggestions from interrupted or timed-out runs.
- Mark old suggestions stale when synchronization reports a new head.

### Likely paths

- `packages/control-center/src/server/agent/AgentRuntimeRegistry.ts`
- `packages/control-center/src/server/agent/internal/PrReviewTaskExecutor.ts`
- `packages/control-center/src/server/application/pullRequestReviews.ts`
- `packages/control-center/src/server/api/ApplicationServices.ts`
- `packages/control-center/src/server/runtime/PrReviewWorkerStartup.ts`
- `packages/control-center/src/api/agent.ts`
- `packages/control-center/src/server/api/handlers/agent-live.ts`
- `packages/control-center/test/agent/pr-review-task-executor.test.ts`
- `packages/control-center/test/application/pull-request-reviews.test.ts`
- `packages/control-center/test/runtime/pr-review-worker-startup.test.ts`
- `packages/control-center/test/api/schemas.test.ts`
- `packages/control-center/test/server-api/handlers.test.ts`

### Tests

- Full run explores fixture files, executes tests, and returns structured suggestions.
- Codex and Claude use the same sandbox tool protocol.
- Provider/model/configuration are persisted on every run.
- Re-review receives summaries plus explicit history lookup.
- Revalidation receives complete selected-suggestion history.
- Base instructions are trusted; head instruction changes cannot redirect the run.
- New head marks old suggestions stale and blocks publication.
- Timeout yields Unable to Conclude with valid partial suggestions retained.
- One schema repair succeeds; second invalid result fails.
- Concurrent independent runs are not application-serialized.

### Exit gate

Agent, application, API, worker, persistence integration, check, lint, and build gates pass with fake models.

## PR 5 — Extend CodeCommit comment publication

### Goal

Support previewed inline/general publication, update, and resolution replies through the existing idempotent ReviewClient seam.

### Changes in `@knpkv/codecommit-core`

- Extend review action models with:
  - Inline pull-request comment location.
  - General pull-request comment.
  - Update existing comment.
  - Reply to existing comment.
- Preserve exact-target preflight and idempotency markers.
- Return comment IDs and safe receipts needed for local publication snapshots.
- Reconcile ambiguous create/update/reply outcomes without replaying writes.
- Expose the current AWS caller identity for publication preview.

### Changes in Control Center

- Build publication previews for:
  - Line anchor.
  - File anchor at first changed line or line 1 fallback.
  - Whole-change general comment.
  - Grouped primary comment with related locations.
  - Explicit split into multiple comments.
  - Update posted comment.
  - Resolution reply.
- Format unified replacement patches as fenced diffs.
- Add visible provenance footer.
- Persist the exact suggestion revision and remote comment receipt.
- Never publish from an agent process or without explicit local confirmation.

### Likely paths

- `packages/codecommit-core/src/ReviewClient/models.ts`
- `packages/codecommit-core/src/ReviewClient/ReviewClient.ts`
- `packages/codecommit-core/src/ReviewClient/ReviewProvider.ts`
- `packages/codecommit-core/test/ReviewClient.test.ts`
- `packages/control-center/src/server/application/pullRequestReviews.ts`
- `packages/control-center/src/api/agent.ts`
- `packages/control-center/src/server/api/handlers/agent-live.ts`
- `packages/control-center/test/application/pull-request-reviews.test.ts`
- `packages/control-center/test/server-api/handlers.test.ts`

### Tests

- Exact line, file fallback, and general anchors.
- Grouped single comment and explicit split.
- Visible provenance footer.
- Identity shown before mutation.
- Duplicate request token returns original receipt.
- Ambiguous mutation reconciles without replay.
- Local edit after publish does not alter remote comment.
- Explicit update and resolution reply use previews and new receipts.

### Exit gate

CodeCommit Core contract, Control Center application/API, check, lint, build, docs, and changesets pass.

## PR 6 — Add first-class Rly diff annotations

### Goal

Allow Control Center to render complete application-owned suggestion cards inline without leaking `@pierre/diffs` types.

### Changes

- Deepen `@knpkv/rly/diff` annotation support:
  - Keep stable semantic annotation identity and anchor.
  - Add an application-owned render interface.
  - Preserve keyboard navigation, focus, virtualization, worker fallback, and line scrolling.
  - Do not import provider, review, or Control Center concepts into Rly.
- Add a compact annotation card shell suitable for rich Control Center content.
- Keep `DiffCodeView` as the only Pierre adapter.
- Add Storybook states:
  - P1–P4.
  - High/medium confidence.
  - Draft, published, stale, resolved, dismissed, reopened.
  - Replacement diff.
  - Long evidence and related locations.
  - Dark and light themes.

### Likely paths

- `packages/rly/src/diff/types.ts`
- `packages/rly/src/diff/DiffCodeView.tsx`
- `packages/rly/src/diff/DiffCodeView.module.css`
- `packages/rly/src/diff/DiffWorkbench.tsx`
- `packages/rly/test/diff/DiffCodeView.test.tsx`
- `packages/rly/stories/diff/DiffCodeView.stories.tsx`
- `packages/rly/README.md`
- `packages/docs/src/content/docs/rly.mdx`

### Tests

- Consumer-rendered annotation receives only Rly types.
- Annotation updates do not reset the diff.
- Keyboard navigation reaches card actions and returns to the anchored line.
- Virtualized and fallback renderers retain annotations.
- Split/stacked modes and before/after sides anchor correctly.
- Storybook and visual classification gates pass.

### Exit gate

Rly test, browser, Storybook, visual, registry, package-contract, check, lint, build, docs, and changeset gates pass.

## PR 7 — Build the integrated review workspace

### Goal

Replace the basic report panel with the approved full-screen, diff-first review experience.

### Changes

- Make the full PR review workspace the default pull-request view.
- Add compact top summary:
  - Derived Review State.
  - Exact reviewed/current head.
  - Coverage and incomplete warning.
  - Severity/state counts.
  - Review or re-review action.
- Add left file/severity/state rail.
- Render suggestions inline in the complete Rly/Pierre diff.
- Add overview cards for file and whole-change anchors.
- Add collapsible Review Thread/live-activity rail.
- Add launch popup with exact head, agent profile, 20-minute budget, and network status.
- Add suggestion actions:
  - Edit.
  - Ask agent to edit.
  - Revalidate.
  - Resolve.
  - Dismiss with reason.
  - Publish preview.
- Add history views for revisions, evidence, dismissal, resolution, and reconciliation.
- Add Suggested Replacement before/after preview.
- Add Review Notes section separate from publishable suggestions.
- Show CodeCommit/Jira collaborators as external people context, not Control Center users.
- Replace two-second polling with the existing durable event replay/live-event mechanism where practical; retain bounded recovery polling only as fallback.

### Likely paths

- `packages/control-center/src/client/entities/WorkspacePullRequestDetails.tsx`
- `packages/control-center/src/client/entities/WorkspacePullRequestDiff.tsx`
- `packages/control-center/src/client/entities/PullRequestReviewPanel.tsx`
- `packages/control-center/src/client/entities/usePullRequestReview.ts`
- `packages/control-center/src/client/entities/WorkspaceEntityRoute.tsx`
- New focused modules under `packages/control-center/src/client/reviews/`
- Corresponding CSS modules and tests

### Tests

- Launch popup displays exact revision and selected profile.
- Live commands appear while speculative suggestions remain hidden.
- Validated suggestion appears at the correct line.
- File/general overview and navigation work.
- Edit, agent edit, revalidation, dismissal, resolution, and history work.
- New head shows stale state and blocks publication.
- Re-review reconciles still-present/resolved/reopened/new states.
- Publication preview shows AWS identity and final content.
- Incomplete run retains publishable validated suggestions and warning.
- Responsive, keyboard, focus, screen-reader, dark, and light behavior.

### Exit gate

Control Center client unit/browser tests, Rly boundaries, check, lint, build, bundle budget, and changeset pass.

## PR 8 — Retention, recovery, telemetry, and end-to-end gates

### Goal

Finish operational behavior and prove the complete local workflow.

### Changes

- Add retention maintenance:
  - Durable threads/suggestions until manual deletion.
  - Sanitized activity/evidence for 30 days.
  - Raw command artifacts for 7 days.
  - Immediate sandbox/staging deletion.
- Reattach to labeled live review containers on startup.
- Mark missing executions interrupted with partial evidence.
- Add metadata-only OpenTelemetry spans and metrics:
  - Opaque run/PR IDs.
  - Revision.
  - Provider/model/CLI version.
  - Phase, command name, duration, exit status.
  - Suggestion counts and error tags.
- Add explicit assertions preventing prompt, source, command output, model output, and replacement content from entering telemetry.
- Add the browser end-to-end happy path and stale-head re-review path.
- Add opt-in real Codex smoke test.
- Update Control Center docs site and package README.

### Likely paths

- `packages/control-center/src/server/runtime/PrReviewWorkerStartup.ts`
- `packages/control-center/src/server/runtime/ControlCenterServer.ts`
- `packages/control-center/src/server/persistence/repositories/prReviewRepository.ts`
- `packages/control-center/test/runtime/observability.test.ts`
- `packages/control-center/test/runtime/pr-review-worker-startup.test.ts`
- `packages/control-center/e2e/pr-review.spec.ts`
- `packages/control-center/test/agent/pr-review-real-codex.test.ts`
- `packages/control-center/README.md`
- `packages/docs/src/content/docs/control-center.mdx`

### Tests

- Retention boundaries with controlled clock.
- Startup reattach and interrupted fallback.
- No content-bearing telemetry attributes or events.
- Real Docker fixture end-to-end.
- Browser launch-to-publication flow with fake provider and fake CodeCommit adapter.
- Stale-head/re-review reconciliation flow.
- Opt-in local authenticated Codex run.

### Final repository gate

- Package tests for all touched packages.
- Typecheck and lint for all touched packages.
- `pnpm lint:ast`.
- Rly Storybook and visual gates.
- Control Center browser and end-to-end suites.
- Production build and JavaScript artifact budget.
- Full repository build/check/lint/test once.
- One consolidated code review against the milestone merge base.

## Explicitly out of scope

- Automatic review on push.
- Automatic CodeCommit comments, approvals, or request-changes.
- Applying Suggested Replacement patches to a branch.
- Credentials inside Review Sandboxes.
- Privileged containers, nested Docker, or host Docker socket access.
- Multi-user collaboration and real-time conflict resolution.
- Migration of previous review records.
- Compatibility with the old capped report schema.
