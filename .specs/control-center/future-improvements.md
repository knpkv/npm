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

The D07 Items route now reads one authenticated, workspace-scoped server index instead of composing
release slices in the browser. The query returns at most 500 latest present projections, includes
unlinked entities, excludes deleted or stale projection heads, and retains up to 500 sorted current
release memberships per object. A unique visible membership routes directly; ambiguous membership
requires an exact release choice. It maps provider service and current status and keeps text, service,
type, status, and canonical human-owner filters in the URL. Active entity-scoped owner assignments
provide bounded names and avatar fallbacks without inventing an owner for unassigned work. Empty, loading, read-failure, and bounded-result states remain
explicit. Those filters now execute against the complete current workspace projection set before the
500-item response bound, and the response reports authoritative matched and total counts.

## Remaining roadmap

- D01–D09 are complete at the intended MVP boundary.
- Read-only production adapters, live connection tests, first-run setup, shared AWS profiles,
  preferred Atlassian OAuth, provider-account ownership, multi-resource following, and bounded batch
  setup are delivered. Provider synchronization is incomplete for Jira and Confluence; all five
  adapters still need their planned governed write capabilities.
- S01–S07 canonical service pages, complete application diff data, durable agent jobs/threads,
  sandbox review, provider administration, and final hardening remain.

The current status, complete task list, faster vertical-slice order, acceptance tests, and explicit
deferrals are in [remaining work](./remaining-work.md). The original capability definitions remain
in `implementation-plan.md` and the milestone files under `plan/`.

## Known non-ideal pieces

- `current-evidence.ts` uses the existing SQL adapter directly. It is intentionally isolated behind
  a private reader so it can later move to `effect-qb` without changing governed-execution callers.
- `begin.ts` deliberately maps the canonical runtime-authority token into the governed connection
  authority digest because both represent the same non-secret configured runtime generation. This
  should become one shared nominal domain type in a future governance cleanup, avoiding the explicit
  schema-brand conversion at the execution boundary.
- `@knpkv/control-center-sql` now isolates `effect-qb` `0.20.0` behind rendered SQL and parameters,
  and the workspace is aligned on Effect `4.0.0-beta.98`. The vendored Effect reference subtree is
  still `beta.97`; update it through the documented subtree workflow before relying on it for a
  beta.98-only API. Migrate the remaining large repository reads incrementally through the same
  deep boundary instead of leaking query-builder types into Control Center.
- The MVP database intentionally has no migration ledger or historical migration files. It creates
  one exact checked-in unstable schema and rejects drift. Start versioned migrations only after the
  persistence model is stable and a released database file must remain readable by a newer build.
  Until then, schema changes are allowed to require recreation of local development data.
- Effect Persistence is not the relational store: its key/value cache and persisted queue do not
  replace joins, constraints, cross-operation transactions, or quarantine. Re-evaluate
  `PersistedQueue` for durable agent jobs and `PersistedCache` for disposable projections after the
  corresponding ownership, replay, and invalidation contracts are defined.
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
- The authenticated command trigger increased the raw initial JavaScript closure from the saturated
  360 KB budget to about 362 KB. The explicit cap is now 365 KB; the generated API client, portfolio
  presenter, and command implementation remain lazy. Recover shell headroom before adding another
  always-mounted capability.
- Command search currently reads one bounded portfolio snapshot when opened because the shared live
  portfolio controller sits below the application shell. Hoist a session-scoped read cache before
  adding more shell consumers; do not introduce a second live stream.
- The private startup smoke executes an authorized fake-provider action while proving that the
  public server discards execution authority. A production runtime registry remains intentionally
  disabled pending production adapter and policy integration.
- Portfolio readiness now performs one bounded, integrity-verified current-head batch read through
  `@knpkv/control-center-sql`. Add the 100-release benchmark before raising the 200-release
  repository bound; digest/materialization verification must remain authoritative and relationship
  counts must not regress to `releaseSlice` hydration.
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
- Items reports `Unassigned` when the graph carries no authoritative owner. Active human entity
  assignments in ownership roles now provide server-authoritative owner data and filtering. Each
  object retains at most 20 ordered owners and the workspace picker retains at most 200 ordered
  people with explicit truncation flags; agent-owned work and role-specific filter facets remain a
  later extension. Text, owner, service, type, and status filters plus aggregate counts are
  server-authoritative; provider-specific full-text indexes remain a later scale optimization.
- The workspace query retains every current release membership up to an explicit per-object bound of 500. The first sorted membership remains the compatibility canonical identifier, while the client
  requires an exact choice whenever more than one membership exists. Memberships outside the current
  bounded portfolio are counted but do not yet expose a release route. Unlinked objects remain on the
  Items route until the provider-specific S01–S07 full views exist.
- The workspace projection query remains explicit Effect SQL. Move it into
  `@knpkv/control-center-sql` only when its current trust, bounds, and quarantine tests can be kept at
  the repository boundary; do not duplicate table definitions inside application services.
- Item and release entry points now converge on an exact item-centered trace inside the selected
  release. It derives incoming/outgoing current relationships, connected objects, lifecycle,
  confidence, and evidence counts from the existing bounded release slice. Each relationship now
  opens a URL-addressable detail sheet that reads its immutable revision ledger and only the evidence
  observations referenced by the selected revision. The existing history and evidence endpoints cap
  results at 200 records without an explicit truncation flag; add that contract before histories can
  exceed the current fixture scale. Command search intentionally routes ambiguous and unlinked objects
  through Items until provider-specific full views exist.
- Authorized shares currently grant one current normalized entity projection to one human person.
  Creation is owner-only, the Items picker uses the existing bounded 200-person owner facet, and the
  page intentionally excludes ordinary workspace navigation, release membership, relationships,
  evidence, and adjacent objects. Cookie-authenticated read recovery remains available without
  browser mutation-proof storage, while watcher sessions cannot use adjacent workspace portfolio,
  live-event, plugin, media, Items, or delivery-graph reads. Workspace owners and approvers retain
  broader application reads through their existing session roles. Resolution rechecks that the named
  grantee remains active before target reads. Create retries preserve both the random share identifier
  and its originally computed expiry.
  Add a paginated workspace people picker, durable share-administration list, and release-scoped grants
  only when those scopes have equally exact response projections and resolution-time authorization.

## Recommended next session

Start M1.1 from [remaining work](./remaining-work.md): add one bounded owner-only manual sync journey
for the production adapters that already negotiate synchronization. Run one consolidated exact-diff
review after focused deterministic gates; turn only recurring, high-impact, mechanically enforceable
findings into static rules or repository instructions.
