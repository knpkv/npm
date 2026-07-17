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
  Reconciliation pending, succeeded, failed, cancelled, and observation-bound
  runtime-generation-unavailable outcomes share one canonical fold engine, exact replay checks,
  backward-compatible durable schemas, and persisted-only restart recovery with dispatch outcomes.
- The live execution store and engine are wired through one private server startup seam. Normal
  startup remains explicitly disabled until an internal plugin-runtime registry is configured;
  source boundaries prevent browser, API, agent, and public runtime barrels from importing the
  worker, and public server layers acquire then discard its `advance` capability.
- Private strict readers load current session, target, projection, and evidence authority without
  falling back to older valid records.
- Referenced evidence items and claims are digest-checked, workspace-scoped, freshness-checked,
  and rejected after a referenced claim is superseded. Claim reads are batched.
- The checkpoint passes repository formatting, linting, static Effect checks, builds, package
  checks, packing validation, browser tests, and exact-head automated review; PR-wide Node 24
  verification remains authoritative for the integrated workspace.
- R01–R16 are delivered as the publishable `@knpkv/rly` design system: generated contracts and
  tokens, light/dark themes, accessible primitives and overlays, release/relationship/people/agent
  patterns, the complete diff workbench, Storybook, visual checks, packed-consumer validation, and
  indexed documentation.
- A06–A07 are delivered as separate Effect AI-compatible `@knpkv/ai-codex` and
  `@knpkv/ai-claude` packages. Both use bounded prompts and reviewed child environments; Codex also
  exposes validated, cancellation-safe native JSONL event streaming and a real opt-in smoke test.
- The production Control Center package now includes the authenticated app server, durable local
  persistence, release portfolio and full release routes, collaborator and release-agent context,
  responsive dark/light presentation, and reusable `rly` composition rather than prototype
  imports.

## Critical checkpoint completed

The D03 begin/recovery failure matrix now covers the real-database happy path, one-use replay,
concurrent duplicate begin, lease-write rollback, runtime rotation, reconciliation deadlines,
changed recovery replay, reconciliation restart folding, expired preparation/authorization/session
boundaries, stale preflight, missing `action.reconcile`, both durable cancellation/reconciliation
orderings for every result kind, and a concurrent terminal race. Real provider mutations remain
disabled until production adapters, policy integration, and an explicit enablement review land.

The first D04 inspection slice exposes bounded, authenticated release graph, relationship revision,
lifecycle history, and evidence reads. The application boundary derives workspace ownership from
the session, rejects missing or cross-workspace releases, and returns only normalized ledger fields.
Evidence claim reads are bounded in SQL rather than only at response encoding.
Read-only repair candidate discovery now derives link/verify suggestions, explanations, impact, and
required permission from those facts. A selected candidate can now be projected into a non-mutating
proposal draft with its exact relationship revision preserved as a future stale-write precondition;
neither read creates a durable proposal or ledger mutation.

The D04 mutation MVP now accepts that draft through a CSRF-protected owner-only endpoint and
persists one pending proposal against the exact workspace, release/environment scope, relationship,
and current ledger revision. Client-supplied UUIDv7 proposal identities make exact retries
idempotent, a partial unique index prevents competing pending proposals for the same revision, and
database triggers bind the proposal to a current owner session and an eligible repair candidate.
Creating a proposal still does not mutate the relationship ledger; review and apply remain separate
governed transitions.

The D04 review slice adds authenticated proposal lookup and bounded newest-first release/environment
lists with optional status filtering. A workspace owner or approver may record one immutable,
client-identified review, but the proposal author cannot review their own intent. Exact review
replays are idempotent; changed or competing decisions conflict. The database binds the reviewer to
a current session, preserves the reviewer actor/rationale/time as an immutable record, and permits
only the matching `pending → approved|rejected` proposal-head transition. Review still does not
mutate the delivery relationship.

The D04 apply slice adds an owner-only, CSRF-protected application endpoint for approved proposals.
One transaction compares the proposal's expected revision with the current relationship head,
appends exactly one immutable successor, and records immutable application authority. Link, verify,
and reject intents become governed, verified, and rejected lifecycle revisions respectively;
existing evidence and edge identity are preserved. Exact retries return the original application,
while stale heads conflict instead of overwriting newer graph state.

The first D04 UI slice adds a release-context decision ledger to the full release view. It loads the
bounded proposal list, presents the exact disposition and revision transition, attributes proposal,
review, and in-session application steps to release collaborators or agents, and exposes only the
review/apply actions permitted by the current session. Review notes are required, review identities
use browser-generated UUIDv7 values, mutations carry the session CSRF proof, and retry/failure/empty
states remain explicit.

The next D04 UI slice adds an owner-only, on-demand candidate path beneath that ledger. It discovers
incomplete release relationships, previews the server-derived disposition, rationale, and exact
revision transition, then creates the governed proposal without mutating the relationship. Proposal
UUIDv7 identities are retained across lost-response retries, while stale drafts and read/mutation
failures remain explicit and retryable.

The D04 ledger now also returns durable application evidence with each bounded proposal page. One
transaction reads the proposal page and a workspace/release-scoped application query limited to
that exact page, and the client hydrates its applied-revision and attribution state from the
response. Applied decisions therefore survive route reloads without per-proposal network or
database fan-out.

The D05 portfolio MVP adds an exact six-release reference fixture spanning blocked, ready,
deploying, building, shipped, and held. Overview now consumes compact server-owned readiness,
Build/Verify/Production, finding, and relationship-count projections; it never derives production
state from CSS or copied labels. All, Need attention, Deploying, and Shipped are large native links
whose counts and rows come from one live release set. Their query state survives direct load,
refresh, Back, unrelated query parameters, and live membership changes without replacing the
selected control or stealing focus. Empty filters recover to All, while each row keeps its Relay
identity, named owner/approver, freshness, service, Jira/PR/pipeline/gap totals, and domain stages.
The relationship totals use one aggregate delivery-graph query rather than hydrating complete
nodes, projections, evidence, and claims.

The D06 work-view MVP adds one compact release relationship card with all six Jira items, two
explicit pull-request groups, pipeline delivery stages, a Confluence runbook, and the unlinked
OPS-433 gap. Every supplied object changes the canonical release URL and leaves a visible selected
object acknowledgement. The full release uses server-owned readiness for its verdict and exposes a
state-specific next action. Active work adds a release-scoped decision surface whose OPS-428
relationship-repair review and rationale survive reload through the existing governed proposal ledger. Compact browser
coverage proves the three dimensions remain complete without horizontal overflow.

The first D07 Items slice adds a workspace route over the existing authenticated release-graph
reads. It deduplicates normalized objects, maps their provider service and current status, bounds
the client index to 500 results, and keeps text, service, type, and status filters in the URL. Every
result opens the selected object in its canonical release workset and returns to the exact filtered
Items origin. Empty, loading, read-failure, and bounded-result states remain explicit.

## Remaining roadmap

- Complete D07 with server-side workspace search/counts, owner filtering, multi-release membership,
  delivery traces, command search, and exact-scope authorized shares. D08–D09 retain timeline and
  exports, graceful drain, and startup reconciliation. D05 performance refinement remains recorded
  below.
- I01–I12: production CodeCommit, CodePipeline, Jira, Confluence, and Clockify adapters plus sync,
  webhooks, configuration, and policy integration.
- S01–S07: complete the full Jira, CodeCommit, Confluence, CodePipeline, and Clockify service pages,
  shared entity shell/presenters, and cross-service route-state acceptance.
- A01–A05 and A08–A12: connect complete provider-backed PR data, durable governed agent jobs and
  release threads, an OpenAI-compatible provider, provider administration, review findings, and
  static-analysis suggestion/application flows. The reusable diff UI and local CLI providers are
  already delivered.
- Complete the adapter-dependent H01–H07 operational, accessibility, and parity work after the
  production integrations above exist. Documentation, changesets, repository gates, exact-commit
  reviews, and PR monitoring for the current safe checkpoint are handled in this branch.

The detailed dependency order remains in `implementation-plan.md` and the milestone files under
`plan/`.

## Known non-ideal pieces

- `current-evidence.ts` uses the existing SQL adapter directly. It is intentionally isolated behind
  a private reader so it can later move to `effect-qb` without changing governed-execution callers.
- `begin.ts` deliberately maps the canonical runtime-authority token into the governed connection
  authority digest because both represent the same non-secret configured runtime generation. This
  should become one shared nominal domain type in a future governance cleanup, avoiding the explicit
  schema-brand conversion at the execution boundary.
- Local `effect-qb` `0.20.0` requires Effect `4.0.0-beta.98`, while this workspace and vendored
  Effect source use `beta.97`. Do not add it until the workspace, lockfile, and vendored subtree are
  aligned deliberately. Migrations, views, triggers, and the isolated repair-proposal repository
  should remain explicit SQL until then.
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
- The private startup smoke executes an authorized fake-provider action while proving that the
  public server discards execution authority. A production runtime registry remains intentionally
  disabled pending production adapter and policy integration.
- Portfolio readiness currently performs one integrity-verified current-head read per release
  inside the snapshot transaction. Add a bounded repository batch read before the 100-release
  benchmark so digest/materialization verification stays authoritative without per-release query
  fan-out. Relationship counts already use a compact aggregate query and should not regress to
  `releaseSlice` hydration.
- D06 object links intentionally converge on the canonical release workset and acknowledge the
  selected object there. Provider-specific Jira, CodeCommit, Confluence, and CodePipeline detail
  routes remain S01–S07 work rather than simulated local pages.
- The D06 pipeline column projects the release's authoritative Build/Verify/Production stages
  because the current delivery-graph pipeline projection carries execution status but not
  provider-stage records. Replace this with provider-owned stage evidence when the CodePipeline
  adapter lands.
- Active work is deliberately release-scoped. Cross-release decision aggregation, sorting, and
  assignment remain later work; the current route preserves exact release selection in its query.
- The D06 Active work MVP keeps provider PR review state read-only. It does not yet implement the
  required not-requested → requested → reviewed/ready-to-merge mutation or a real-runtime restart
  test for that transition. Relationship-repair approval remains a separate governed D04 workflow;
  add a dedicated PR-review domain/API/persistence path before claiming the D06 review lifecycle.
- D06 verdict actions are state-specific navigation to the relevant decision/evidence surface, not
  remote mutations. Governed deploy, watch, notify, acknowledge, and trace-repair completion remain
  adapter-dependent action work and must reuse the D03 authority/idempotency boundary.
- The first Items slice deliberately composes existing bounded per-release reads in the browser.
  It reports normalized objects honestly, including `Unassigned` when the graph carries no owner,
  but does not yet expose authoritative owner data or an owner filter. Replace it with one bounded
  server query before large workspaces; return aggregate counts from that query instead of loading
  every release slice.
- Items currently deduplicates an object that appears in multiple release slices to its first stable
  release route. The complete trace model must retain every release membership and require an
  explicit release choice where context is ambiguous.
- Delivery trace entry points, global command search, and authenticated share grants with exact
  scope, expiry, revocation, and grantee checks remain unfinished D07 work. No current Items control
  implies those capabilities.

## Recommended next session

Complete D07 delivery traces and authorized shares around the Items checkpoint, then return to the
recorded D05 readiness batch optimization before the large-fixture performance gate.
Run one independent exact-commit review after each deterministic milestone gate; turn recurring,
high-impact, mechanically enforceable findings into static rules or repository instructions.
