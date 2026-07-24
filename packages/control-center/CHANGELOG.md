# @knpkv/control-center

## 0.3.0

### Minor Changes

- [#256](https://github.com/knpkv/npm/pull/256) [`00ede59`](https://github.com/knpkv/npm/commit/00ede595e7521d334cdeb3101b2e30bdf2486cd7) Thanks [@konopkov](https://github.com/konopkov)! - Add the canonical read-first CodePipeline execution page with bounded stage and action detail, human attribution, delivery evidence, and proxy-only artifact metadata.

- [#270](https://github.com/knpkv/npm/pull/270) [`f7ffb0f`](https://github.com/knpkv/npm/commit/f7ffb0f834bf368598019fe7b3c1e05029c8a88e) Thanks [@konopkov](https://github.com/konopkov)! - Add host-side pull-request review orchestration that sends base-to-head changed-line sandbox evidence to an explicitly selected prompt-only agent, validates structured findings against exact evidence anchors, derives stable finding identities before durable persistence, and keeps release-chat workers independent from opt-in sandbox configuration. Add task-scoped agent-job dispatch query inputs to the SQL package.

- [#260](https://github.com/knpkv/npm/pull/260) [`38848a2`](https://github.com/knpkv/npm/commit/38848a2660aa98295f96d54d232e4cec15ea95a5) Thanks [@konopkov](https://github.com/konopkov)! - Add a read-first Clockify time-entry page with deterministic totals, source facts, people roles, and explicit Jira attribution states.

- [#264](https://github.com/knpkv/npm/pull/264) [`1873b71`](https://github.com/knpkv/npm/commit/1873b71e9223db481531cbf549accbf73f1dfbe4) Thanks [@konopkov](https://github.com/konopkov)! - Add revision-inspected Jira proposals for reply fallbacks, fix-version assignments, and issue-link associations. Provider writes remain unnegotiated until atomic revision guards or explicit append-only authorization semantics are available.

- [#258](https://github.com/knpkv/npm/pull/258) [`864d595`](https://github.com/knpkv/npm/commit/864d595f66135c47ca2d4b125137b6bee4cecfc2) Thanks [@konopkov](https://github.com/konopkov)! - Add the canonical read-first Confluence page with safely rendered content, revision history, human attribution, bounded attachment metadata, and explicit lazy and partial states.

- [#262](https://github.com/knpkv/npm/pull/262) [`dd0163e`](https://github.com/knpkv/npm/commit/dd0163ec002ae8abbce0b19df61431b3a4701314) Thanks [@konopkov](https://github.com/konopkov)! - Add immutable CodeCommit pull-request review actions with governed proposals, durable provider receipts, and non-replaying reconciliation.

- [#271](https://github.com/knpkv/npm/pull/271) [`30eda5a`](https://github.com/knpkv/npm/commit/30eda5a171909a1c3339a8d5307771a1f14401c7) Thanks [@konopkov](https://github.com/konopkov)! - Add authenticated exact-head pull-request review state and enqueue APIs, durable latest-review lookup, provider capability discovery, and a compact PR-page review surface for pending, failed, and completed findings. Split the agent API contract into its own lazy browser chunk so the generated client remains within its enforced artifact budget.

- [#266](https://github.com/knpkv/npm/pull/266) [`d973d9a`](https://github.com/knpkv/npm/commit/d973d9a4bb9753f9a907f182c6b14a4528266765) Thanks [@konopkov](https://github.com/konopkov)! - Connect complete, immutable CodeCommit pull-request inventories and lazy bounded content reads to the authenticated rly diff workbench.

- [#263](https://github.com/knpkv/npm/pull/263) [`87e2666`](https://github.com/knpkv/npm/commit/87e266624c2d82abe2757669726e55bcf04b4728) Thanks [@konopkov](https://github.com/konopkov)! - Add revision-inspected Jira comment proposals while keeping Jira provider writes unnegotiated. Comment execution, description replacement, and workflow transitions remain disabled until Jira exposes an atomic provider revision guard or the product adopts an explicit append-only authorization contract.

- [#261](https://github.com/knpkv/npm/pull/261) [`1d28dff`](https://github.com/knpkv/npm/commit/1d28dffd133b81d0b4ffc69ff0aba55995dfe02d) Thanks [@konopkov](https://github.com/konopkov)! - Preserve exact workspace route context and restore the prior scroll position after canonical entity round trips.

- [#265](https://github.com/knpkv/npm/pull/265) [`a974cdf`](https://github.com/knpkv/npm/commit/a974cdff01a50f75da1b9e33f1ddef0c97bb9b37) Thanks [@konopkov](https://github.com/konopkov)! - Add server-only Codex, Claude, and OpenAI-compatible agent provider administration with explicit durable model and read-only profile selection, bounded contextual prompts and remote deadlines, redacted health, fail-closed runtime routing, and intentional legacy-model reconciliation.

- [#268](https://github.com/knpkv/npm/pull/268) [`b546479`](https://github.com/knpkv/npm/commit/b546479b794753ebb20a1b57af18916af13cc55e) Thanks [@konopkov](https://github.com/konopkov)! - Add an internal immutable pull-request static-analysis sandbox with digest-pinned images, non-root read-only networkless execution, bounded evidence, exact-head verification, and cancellation-safe container cleanup.

- [#267](https://github.com/knpkv/npm/pull/267) [`e0d7e9a`](https://github.com/knpkv/npm/commit/e0d7e9a4153a97f3cedaac3b41e7e2790170317c) Thanks [@konopkov](https://github.com/konopkov)! - Add bounded, durable pull-request review task results with structured prevention proposals.

- [#269](https://github.com/knpkv/npm/pull/269) [`2112142`](https://github.com/knpkv/npm/commit/21121422eb3a4f2be9d975ebb6015bc7381dd305) Thanks [@konopkov](https://github.com/konopkov)! - Render complete CodeCommit file changes as an on-demand split or unified line diff, and add a strict-budget rly diff entry backed by the Diffs parser.

### Patch Changes

- [#259](https://github.com/knpkv/npm/pull/259) [`7da266b`](https://github.com/knpkv/npm/commit/7da266bbb8cbf47f0f826274cc890384011e08e0) Thanks [@konopkov](https://github.com/konopkov)! - Make CodeCommit manual synchronization resilient to real provider responses.
  Pull-request decoding now normalizes untrimmed titles and tolerates omitted
  author identities instead of failing the whole stream, and schema-decode
  failures are surfaced in logs with the offending field. Reduce the
  GetPullRequest hydration fan-out to stay under CodeCommit's throttle ceiling,
  and honor a bounded provider Retry-After when retrying rate-limited syncs.
  Correct the manual-sync timestamp rendering and show an explicit in-progress
  state in the services UI.
- Updated dependencies [[`f7ffb0f`](https://github.com/knpkv/npm/commit/f7ffb0f834bf368598019fe7b3c1e05029c8a88e), [`38848a2`](https://github.com/knpkv/npm/commit/38848a2660aa98295f96d54d232e4cec15ea95a5), [`dd0163e`](https://github.com/knpkv/npm/commit/dd0163ec002ae8abbce0b19df61431b3a4701314), [`30eda5a`](https://github.com/knpkv/npm/commit/30eda5a171909a1c3339a8d5307771a1f14401c7), [`7da266b`](https://github.com/knpkv/npm/commit/7da266bbb8cbf47f0f826274cc890384011e08e0), [`d973d9a`](https://github.com/knpkv/npm/commit/d973d9a4bb9753f9a907f182c6b14a4528266765), [`e0d7e9a`](https://github.com/knpkv/npm/commit/e0d7e9a4153a97f3cedaac3b41e7e2790170317c), [`2112142`](https://github.com/knpkv/npm/commit/21121422eb3a4f2be9d975ebb6015bc7381dd305)]:
  - @knpkv/control-center-sql@0.2.0
  - @knpkv/clockify-api-client@1.0.3
  - @knpkv/codecommit-core@0.10.0
  - @knpkv/rly@0.2.0

## 0.2.0

### Minor Changes

- [#254](https://github.com/knpkv/npm/pull/254) [`7e99738`](https://github.com/knpkv/npm/commit/7e99738a71036b2f313f8b0260df00ceb8d10efb) Thanks [@konopkov](https://github.com/konopkov)! - Add a canonical CodeCommit pull-request page with immutable head/base revision details, synchronized author and lifecycle metadata, human review state, delivery evidence counts, a files entry point, and a release-aware agent review action.

### Patch Changes

- Updated dependencies [[`521c44e`](https://github.com/knpkv/npm/commit/521c44e9b9d6f4adc3e5ba44f1d9f117698d4442), [`6d510c9`](https://github.com/knpkv/npm/commit/6d510c9d3dab3e459db7fa1d25cd12f0e122699e)]:
  - @knpkv/clockify-api-client@1.0.2
  - @knpkv/jira-api-client@1.0.1

## 0.1.1

### Patch Changes

- [#251](https://github.com/knpkv/npm/pull/251) [`bf74411`](https://github.com/knpkv/npm/commit/bf744117e07b84b28e139ee131687fd36d080e3e) Thanks [@konopkov](https://github.com/konopkov)! - Patch two high-severity transitive dependency advisories via `pnpm-workspace.yaml`
  overrides:

  - **fast-uri** — bump `<=3.1.3` to `^3.1.4` (GHSA-v2hh-gcrm-f6hx: host confusion
    via literal backslash authority delimiter). Pulled in through `ajv`; affects
    `@knpkv/confluence-to-markdown` and `@knpkv/rly`.
  - **fast-xml-parser** — bump the `@distilled.cloud/aws` override from `^5.3.4` to
    `^5.10.1` (GHSA-8r6m-32jq-jx6q: repeated DOCTYPE declarations reset entity
    expansion limits). Affects `@knpkv/codecommit-core` and `@knpkv/control-center`.

  No source changes; `pnpm audit --prod && pnpm audit --dev` now reports no known
  vulnerabilities.

- Updated dependencies [[`5a61061`](https://github.com/knpkv/npm/commit/5a610619cef7609148b396d9248924422138221b), [`bf74411`](https://github.com/knpkv/npm/commit/bf744117e07b84b28e139ee131687fd36d080e3e)]:
  - @knpkv/clockify-api-client@1.0.1
  - @knpkv/confluence-to-markdown@2.1.2
  - @knpkv/codecommit-core@0.9.1
  - @knpkv/rly@0.1.1

## 0.1.0

### Minor Changes

- [#243](https://github.com/knpkv/npm/pull/243) [`5bb6920`](https://github.com/knpkv/npm/commit/5bb69209b12233cfb3601c4365eabb4e5b27206c) Thanks [@konopkov](https://github.com/konopkov)! - Add bounded manual Jira project synchronization with canonical issue, collaborator, evidence, and fix-version release materialization.

- [#244](https://github.com/knpkv/npm/pull/244) [`459962f`](https://github.com/knpkv/npm/commit/459962f2d71a8d36ffdb5fd4cf1b70d413973445) Thanks [@konopkov](https://github.com/konopkov)! - Add bounded AWS CodeCommit and CodePipeline resource discovery to Control Center onboarding, including verified account identity, partial-permission handling, searchable selection with manual fallback, and the manual synchronization controls for supported service connections.

- [#162](https://github.com/knpkv/npm/pull/162) [`6bcc6ef`](https://github.com/knpkv/npm/commit/6bcc6ef636df11a7cb54b6eee4322c79ac07fa05) Thanks [@konopkov](https://github.com/konopkov)! - Add an owner-only Timeline event detail sheet with durable provenance and a contextual Relay entry.

- [#160](https://github.com/knpkv/npm/pull/160) [`eeb0473`](https://github.com/knpkv/npm/commit/eeb0473ce623b9e325a0c50afc15be39360965bb) Thanks [@konopkov](https://github.com/konopkov)! - Record immutable, session-attributed audit metadata for successful Timeline CSV
  and JSON downloads before response streaming begins.

- [#235](https://github.com/knpkv/npm/pull/235) [`5a177cd`](https://github.com/knpkv/npm/commit/5a177cd61745795ef7974f50570297af8f6a5597) Thanks [@konopkov](https://github.com/konopkov)! - Add authenticated durable release-agent job enqueue and bounded ordered thread replay endpoints with server-derived workspace and context ownership.

- [#231](https://github.com/knpkv/npm/pull/231) [`c8df50c`](https://github.com/knpkv/npm/commit/c8df50cf35a05e66b8621a4faacfca53426eb8f1) Thanks [@konopkov](https://github.com/konopkov)! - Add a provider-neutral durable agent worker that claims one release job, persists validated runtime events and terminal failures, and completes recovered cancellations without relaunching a provider. Make the first validated terminal runtime event authoritative so never-ending provider transports are interrupted promptly.

- [#151](https://github.com/knpkv/npm/pull/151) [`9993948`](https://github.com/knpkv/npm/commit/99939484f3d29e63bfcc76d4df68d33e57a6277a) Thanks [@konopkov](https://github.com/konopkov)! - Add exact-item authenticated share grants with expiry, revocation, and direct-load recovery.

- [#247](https://github.com/knpkv/npm/pull/247) [`4e03e7a`](https://github.com/knpkv/npm/commit/4e03e7ad7302a0fa4993f528fdc07cf7072ef71d) Thanks [@konopkov](https://github.com/konopkov)! - Add a canonical full-page route for normalized workspace entities with exact
  origin restoration, provenance, freshness, collaborators, bounded delivery
  relationships, attributable activity, and contextual agent entry. Back the
  page with an authorized typed entity read model and effect-qb query plans.

- [#158](https://github.com/knpkv/npm/pull/158) [`a5f5e6c`](https://github.com/knpkv/npm/commit/a5f5e6c0651428b37ae14c385c087922cc6be5cb) Thanks [@konopkov](https://github.com/konopkov)! - Add a production AWS CodePipeline read adapter with direct Schema-wrapped
  `distilled-aws` operations, bounded execution and action pagination, stable
  pipeline/execution/stage/action normalization, typed failures, and
  credential-free artifact proxy metadata.

- [#149](https://github.com/knpkv/npm/pull/149) [`a8782ae`](https://github.com/knpkv/npm/commit/a8782aea401aa5861206cc764740630a3e0f4367) Thanks [@konopkov](https://github.com/konopkov)! - Add an authenticated release-and-item command search with exact navigation, keyboard control, and contextual Relay access.

- [#152](https://github.com/knpkv/npm/pull/152) [`79410da`](https://github.com/knpkv/npm/commit/79410daec02e4923accf842eb55bac325d76d781) Thanks [@konopkov](https://github.com/konopkov)! - Add a bounded production Confluence Cloud adapter for current page, version history, contributor, and safe content reads.

- [#163](https://github.com/knpkv/npm/pull/163) [`0773fde`](https://github.com/knpkv/npm/commit/0773fdea4c6b85138852b35d8e5aab9b31428db2) Thanks [@konopkov](https://github.com/konopkov)! - Add owner-only live connection tests with retryable UI states, provider latency,
  and normalized secret-free account identity evidence.

- [#234](https://github.com/knpkv/npm/pull/234) [`7904c3e`](https://github.com/knpkv/npm/commit/7904c3e49e1500f6f42a2c3786d3ff9c76b5fcc4) Thanks [@konopkov](https://github.com/konopkov)! - Add durable release-scoped agent threads, transactional job attempts and leases, bounded event replay, and effect-qb claim and recovery plans.

- [#155](https://github.com/knpkv/npm/pull/155) [`58bb138`](https://github.com/knpkv/npm/commit/58bb138045504ef5e354f873e56ddaee87cfa144) Thanks [@konopkov](https://github.com/konopkov)! - Replace portfolio readiness N+1 reads with one bounded, parameterized
  `effect-qb` query plan while retaining Schema decoding, materialization
  verification, and malformed-row quarantine.

  Reset prototype persistence to one exact unstable schema snapshot. Historical
  migrations and the migration ledger are intentionally removed until the data
  model is stable and released databases require forward upgrades.

- [#166](https://github.com/knpkv/npm/pull/166) [`94831b5`](https://github.com/knpkv/npm/commit/94831b5d1458e1d20aaa6290250497f3c84d5075) Thanks [@konopkov](https://github.com/konopkov)! - Wire the production Control Center CLI to a workspace-scoped first-party plugin
  runtime backed by persisted configuration, owner-only secret references, real
  provider clients, and a shared invalidatable cache.

- [#126](https://github.com/knpkv/npm/pull/126) [`c770262`](https://github.com/knpkv/npm/commit/c7702624d7e388f6e9e3cd0dc93845e195737406) Thanks [@konopkov](https://github.com/konopkov)! - Scaffold the Control Center application with explicit browser, API, domain, and server boundaries.

  Add Schema-backed canonical identities, UTC timestamps, explicit source provenance and freshness, human and agent actors, scoped collaborator roles, foundational release records, and the deterministic persisted `relay/v1` release-identity projection.

  Add ordered libSQL migrations, workspace-scoped optimistic repositories, malformed-record quarantine, and an owner-only content-addressed blob boundary for durable application state.

  Add the immutable normalized delivery graph and evidence ledger with exact entity revisions, explicit missing nodes, directional many-to-many relationships, lifecycle, confidence, provenance, release/environment scope, independent evidence validity and retention, and a bounded atomic read/write persistence interface.

  Add hash-only local pairing and session authentication, owner-controlled device and session revocation, audited terminal-only owner recovery, strict loopback/LAN request policy with explicit TLS secret references, and an owner-only scoped secret store for provider credentials.

  Add the versioned vendor-neutral plugin contract, capability negotiation, scoped connection registry, deterministic fake adapter, typed partial-failure and retry policy, atomic checkpoint/cache persistence, and a sealed governed-action execution boundary.

  Add canonical workspace release routes with compact row-to-preview activation,
  an explicit full-view transition, truthful unavailable-data states, complete
  collaborator context, refresh-safe origin handling, and a release-aware agent
  entry. Preserve focus, inert isolation, scroll locking, browser history, direct
  loads, compact sheets, unknown-resource behavior, and reduced-motion-safe
  shared geometry across the transition. Validate every consumed rly CSS token
  against the generated design-system contract during static checks.

- [#126](https://github.com/knpkv/npm/pull/126) [`c770262`](https://github.com/knpkv/npm/commit/c7702624d7e388f6e9e3cd0dc93845e195737406) Thanks [@konopkov](https://github.com/konopkov)! - Add the durable governed-action ledger and sealed execution engine with persisted runtime-authority generations, canonical authority proofs, fresh server-owned policy evaluation, copy-on-write credential rotation, exact command replay, atomic transition and audit commits, verified lifecycle reads, non-replaying recovery, and corruption quarantine.

- [#169](https://github.com/knpkv/npm/pull/169) [`4ca6c3c`](https://github.com/knpkv/npm/commit/4ca6c3c063388357d4e2db0078109510ab6b2b96) Thanks [@konopkov](https://github.com/konopkov)! - Add the first shared graceful-drain lifecycle for the runnable server. Signal
  shutdown now rejects new mutations and live streams, closes existing event
  streams, waits within a hard deadline for admitted mutations, and then releases
  scoped runtime resources.

- [#126](https://github.com/knpkv/npm/pull/126) [`c770262`](https://github.com/knpkv/npm/commit/c7702624d7e388f6e9e3cd0dc93845e195737406) Thanks [@konopkov](https://github.com/konopkov)! - Add the versioned typed HTTP API, authenticated Node runtime, immutable static application, first-run browser pairing, plugin configuration persistence, atomic fake-release synchronization, and a server-authoritative dark Overview with release identity, collaborators, readiness placeholders, provenance, freshness, health, and resilient loading, empty, stale, and error states.

- [#147](https://github.com/knpkv/npm/pull/147) [`4ce1bb5`](https://github.com/knpkv/npm/commit/4ce1bb55d328f730bff174c6fe07f23f54d606f0) Thanks [@konopkov](https://github.com/konopkov)! - Show a compact item-centered delivery trace with connected objects,
  relationship lifecycle, confidence, and evidence counts in each exact release
  context.

- [#146](https://github.com/knpkv/npm/pull/146) [`0410326`](https://github.com/knpkv/npm/commit/04103269b96b635bdb153065717c47941351927f) Thanks [@konopkov](https://github.com/konopkov)! - Retain every bounded current release membership in workspace item results and
  require an explicit release choice when an item belongs to multiple releases.

- [#248](https://github.com/knpkv/npm/pull/248) [`ca0ddf3`](https://github.com/knpkv/npm/commit/ca0ddf337b949c4d417cc2b0004c3a2ffe2ba49a) Thanks [@konopkov](https://github.com/konopkov)! - Preserve complete bounded Jira issue detail in canonical projections and render
  description, acceptance criteria, people, fields, hierarchy, comments, history,
  and explicit truncation state in the read-only full-page entity view.

- [#237](https://github.com/knpkv/npm/pull/237) [`0bca514`](https://github.com/knpkv/npm/commit/0bca51411408c30041d966812e75eb7c64d61c2b) Thanks [@konopkov](https://github.com/konopkov)! - Add owner-triggered bounded synchronization for CodeCommit, CodePipeline, and Clockify connections, with durable attempt state and canonical Items and Timeline materialization. State reads remain observational, crash-left attempts reconcile when an owner starts the next synchronization, and a full 100-page invocation records successful checkpoint progress for the next run.

- [#236](https://github.com/knpkv/npm/pull/236) [`742072a`](https://github.com/knpkv/npm/commit/742072a2d4359eee512d6e4d525adc51564a1e64) Thanks [@konopkov](https://github.com/konopkov)! - Add an atomic, replay-safe application seam that commits normalized plugin pages
  and materializes their accepted people, entities, tombstones, evidence, and
  relationships into the canonical delivery graph used by Items.

- [#126](https://github.com/knpkv/npm/pull/126) [`c770262`](https://github.com/knpkv/npm/commit/c7702624d7e388f6e9e3cd0dc93845e195737406) Thanks [@konopkov](https://github.com/konopkov)! - Add offline `backup`, `verify-backup`, and `restore` commands with verified archives, non-mutating private SQLite snapshots, atomic no-clobber restore, stable terminal output, cause-preserving failures, and static boundary checks for the public backup API.

- [#228](https://github.com/knpkv/npm/pull/228) [`48116fb`](https://github.com/knpkv/npm/commit/48116fbdefa0574f070df6e024766f131672048d) Thanks [@konopkov](https://github.com/konopkov)! - Configure the shared Atlassian OAuth app directly in Control Center without requiring Jira or Confluence CLIs.

- [#150](https://github.com/knpkv/npm/pull/150) [`136796d`](https://github.com/knpkv/npm/commit/136796da9095866d9b713179b9bae6e2416b9321) Thanks [@konopkov](https://github.com/konopkov)! - Add server-authoritative owner identities, URL filtering, and compact human attribution to workspace items.

- [#148](https://github.com/knpkv/npm/pull/148) [`9c2037a`](https://github.com/knpkv/npm/commit/9c2037a51a43ee64244a7250f88cc7b06b72e94c) Thanks [@konopkov](https://github.com/konopkov)! - Add URL-addressable relationship detail sheets with immutable revision history
  and exact evidence provenance from the authenticated delivery graph.

- [#137](https://github.com/knpkv/npm/pull/137) [`0898b2c`](https://github.com/knpkv/npm/commit/0898b2c677e609735933263a8dd0ab97aecc347f) Thanks [@konopkov](https://github.com/konopkov)! - Apply approved relationship-repair proposals as immutable compare-and-swap ledger revisions.

- [#138](https://github.com/knpkv/npm/pull/138) [`4c607e9`](https://github.com/knpkv/npm/commit/4c607e99b00bce2e467a32049038b8aba2374302) Thanks [@konopkov](https://github.com/konopkov)! - Add the release repair decision ledger with human-attributed proposal review and application actions.

- [#135](https://github.com/knpkv/npm/pull/135) [`4587021`](https://github.com/knpkv/npm/commit/45870215fc2d161678d7c51ee51d6c5b0c9c355e) Thanks [@konopkov](https://github.com/konopkov)! - Add owner-authorized, CSRF-protected relationship-repair proposal creation with durable session provenance, exact release/environment scope, revision compare-and-swap guards, idempotent proposal identities, and competing-proposal prevention.

- [#136](https://github.com/knpkv/npm/pull/136) [`18965f3`](https://github.com/knpkv/npm/commit/18965f387e293e32fb92c4cfe4cd7b63d58b2c15) Thanks [@konopkov](https://github.com/konopkov)! - Add bounded relationship-repair proposal reads and immutable, independently authorized proposal reviews.

- [#126](https://github.com/knpkv/npm/pull/126) [`c770262`](https://github.com/knpkv/npm/commit/c7702624d7e388f6e9e3cd0dc93845e195737406) Thanks [@konopkov](https://github.com/konopkov)! - Add canonical per-release Relay threads backed by bounded, authenticated local Codex or Claude turns, and preserve multiline agent answers in rly threads.

- [#142](https://github.com/knpkv/npm/pull/142) [`2575510`](https://github.com/knpkv/npm/commit/25755106ed25b1cdb5304089bc7c71c041cf1177) Thanks [@konopkov](https://github.com/konopkov)! - Add compact release work views that connect Jira items, CodeCommit pull requests, CodePipeline
  delivery, Confluence runbooks, relationship gaps, and durable human review decisions.

- [#140](https://github.com/knpkv/npm/pull/140) [`6041fc2`](https://github.com/knpkv/npm/commit/6041fc2ca2c18ba98441ff93ff5da9bb693f71db) Thanks [@konopkov](https://github.com/konopkov)! - Hydrate durable relationship repair application evidence with release proposal pages so applied decisions survive reloads.

- [#139](https://github.com/knpkv/npm/pull/139) [`7b06b20`](https://github.com/knpkv/npm/commit/7b06b20fed4cb376e9f7a1e2af2c4c209e0c1aca) Thanks [@konopkov](https://github.com/konopkov)! - Add owner-only relationship repair candidate discovery, exact proposal previews, and idempotent proposal creation to full release views.

- [#145](https://github.com/knpkv/npm/pull/145) [`de85cfc`](https://github.com/knpkv/npm/commit/de85cfce571b6a81ec3ae8705f724d6130ec12d3) Thanks [@konopkov](https://github.com/konopkov)! - Filter workspace items on the server before applying the bounded response
  limit, and return authoritative matched and total item counts.

- [#168](https://github.com/knpkv/npm/pull/168) [`e888f42`](https://github.com/knpkv/npm/commit/e888f4231f529d163a8219b84e1fe8377a9404b7) Thanks [@konopkov](https://github.com/konopkov)! - Let workspace owners enable or disable configured services in place, verify a re-enabled identity immediately, and enter first-service setup directly from an empty Overview.

- [#167](https://github.com/knpkv/npm/pull/167) [`ebb65c3`](https://github.com/knpkv/npm/commit/ebb65c3f9f2c51235421da774a211954206532ab) Thanks [@konopkov](https://github.com/konopkov)! - Show the five first-party services on fresh workspaces and let workspace owners create, configure, enable, and immediately test a connection without exposing credential values.

- [#141](https://github.com/knpkv/npm/pull/141) [`e966c29`](https://github.com/knpkv/npm/commit/e966c29526522e1eac112533e70e3e39041e3ced) Thanks [@konopkov](https://github.com/konopkov)! - Add the six-state Control Center portfolio with authoritative readiness and
  delivery-stage projections, compact Jira/PR/pipeline relationship totals, and
  large URL-backed All, Need attention, Deploying, and Shipped filters. Include
  the six-release browser reference fixture, recoverable empty views, live count
  coherence, stable focus, and keyboard/back/refresh acceptance coverage.

  Expose stable release-fact identifiers from rly so applications can apply
  service-specific accents without coupling to generated CSS module names.

- [#159](https://github.com/knpkv/npm/pull/159) [`ab1da55`](https://github.com/knpkv/npm/commit/ab1da556cee4521c61bdda1307c50db64bc1286b) Thanks [@konopkov](https://github.com/konopkov)! - Add authenticated, default-redacted CSV and JSON Timeline downloads with actor
  and UTC date filters, stable bounded pagination, and explicit truncation metadata.

- [#157](https://github.com/knpkv/npm/pull/157) [`933c53b`](https://github.com/knpkv/npm/commit/933c53b22999c5a0c5d4ee91653b76b81e2a6824) Thanks [@konopkov](https://github.com/konopkov)! - Add a default-redacted, stable-paginated workspace Timeline across governed
  actions, plugin syncs, delivery relationships, and durable system events. Render
  its bounded persistence reads with private `effect-qb` plans and expose a compact
  agent-aware workspace view with actor and UTC date filters.

- [#126](https://github.com/knpkv/npm/pull/126) [`c770262`](https://github.com/knpkv/npm/commit/c7702624d7e388f6e9e3cd0dc93845e195737406) Thanks [@konopkov](https://github.com/konopkov)! - Add verified backup restoration into a fresh, atomically published data root.

  Preserve durable evidence, expose restart-visible refetch states for missing or
  corrupt reproducible cache content, authorize repairs through persisted content
  metadata, and enforce restore safety through declaration, source-boundary,
  static-analysis, migration, interruption, and restart regression checks.

- [#144](https://github.com/knpkv/npm/pull/144) [`d9d9847`](https://github.com/knpkv/npm/commit/d9d9847c49cb1cf047125637d883d37ebb7fac18) Thanks [@konopkov](https://github.com/konopkov)! - Load the Items view from one bounded authenticated workspace entity index.
  Include unlinked current projections, exclude deleted or stale heads, preserve
  canonical release links where available, and report server-side truncation.

- [#246](https://github.com/knpkv/npm/pull/246) [`2ce3dff`](https://github.com/knpkv/npm/commit/2ce3dffc5f2fa1aad5ee803a569d728fac4c3a22) Thanks [@konopkov](https://github.com/konopkov)! - Infer evidence-backed Jira, CodeCommit, CodePipeline, Confluence, and Clockify relationships in release worksets while keeping inferred and missing links visibly distinct and available to governed repair.

- [#185](https://github.com/knpkv/npm/pull/185) [`e9c2515`](https://github.com/knpkv/npm/commit/e9c2515677ff3bce13c8791481307c0982b60f6f) Thanks [@konopkov](https://github.com/konopkov)! - Materialize discovered AWS accounts and followed CodeCommit or CodePipeline resources during successful connection setup.

- [#184](https://github.com/knpkv/npm/pull/184) [`88bc8c8`](https://github.com/knpkv/npm/commit/88bc8c81c9909f26b3e35328559761c98db7f84d) Thanks [@konopkov](https://github.com/konopkov)! - Bind executable plugin connections to followed resources under a shared provider account, with database-enforced service and ownership invariants.

- [#183](https://github.com/knpkv/npm/pull/183) [`c5f2d10`](https://github.com/knpkv/npm/commit/c5f2d103dfa6983c2b28ee6da57151d80d1d503e) Thanks [@konopkov](https://github.com/konopkov)! - Add first-class provider accounts and independently followed resources, including an AWS account shared by multiple CodeCommit repositories and CodePipeline pipelines.

- [#187](https://github.com/knpkv/npm/pull/187) [`1bba5c2`](https://github.com/knpkv/npm/commit/1bba5c282684553fbc670e6dcf2960e8a4e200ed) Thanks [@konopkov](https://github.com/konopkov)! - Add reusable application callback URLs to Atlassian OAuth helpers and an OAuth-first Control Center connection flow with PKCE, session-bound single-use grants, explicit site selection, and shared Jira/Confluence local profiles.

- [#190](https://github.com/knpkv/npm/pull/190) [`e4df49e`](https://github.com/knpkv/npm/commit/e4df49e2fc619daee01c54005f2a8dc9fb8dee25) Thanks [@konopkov](https://github.com/konopkov)! - Materialize one provider-verified Atlassian site shared by Jira and Confluence, bind immutable Jira projects and Confluence spaces after healthy setup, and present multiple followed resources on one account-level Services card. OAuth is the preferred shareable Jira identity; API-token Jira remains a standalone fallback when Jira cannot prove the cloud ID.

- [#245](https://github.com/knpkv/npm/pull/245) [`a700e03`](https://github.com/knpkv/npm/commit/a700e036552fb23adf87b9b0325cde0354d97c9c) Thanks [@konopkov](https://github.com/konopkov)! - Add bounded Confluence space synchronization with lazy page content, collaborators, attachment metadata, and runbook evidence.

- [#154](https://github.com/knpkv/npm/pull/154) [`fe27e3c`](https://github.com/knpkv/npm/commit/fe27e3c74630d52b25d840e10fe8ea58b38b6b65) Thanks [@konopkov](https://github.com/konopkov)! - Add the Schema-decoded CodeCommit pull-request and changed-file read boundary and a read-only Control Center adapter with cursor pagination.

- [#161](https://github.com/knpkv/npm/pull/161) [`e8a055b`](https://github.com/knpkv/npm/commit/e8a055b0190e4ac4d75716e6e1cbedb6253861a7) Thanks [@konopkov](https://github.com/konopkov)! - Add an owner-only exact Timeline event detail endpoint that exposes durable
  identifiers and agent-job attribution without weakening default page redaction.

### Patch Changes

- [#179](https://github.com/knpkv/npm/pull/179) [`41565ba`](https://github.com/knpkv/npm/commit/41565ba9d1adf50abf36620dec1e9dee516f5133) Thanks [@konopkov](https://github.com/konopkov)! - Expose credential-free AWS CLI profile discovery from CodeCommit Core and use
  the shared profile catalogue when configuring CodeCommit and CodePipeline in
  Control Center.

- [#189](https://github.com/knpkv/npm/pull/189) [`1a1cd08`](https://github.com/knpkv/npm/commit/1a1cd08370aab1b73e4fcfe1ece70b758a9b250d) Thanks [@konopkov](https://github.com/konopkov)! - Move multi-resource connection setup behind one bounded server batch with ordered, redacted per-resource results.

- [#172](https://github.com/knpkv/npm/pull/172) [`371bc0e`](https://github.com/knpkv/npm/commit/371bc0eda38efca829e61fc1e6bb7493319bfc28) Thanks [@konopkov](https://github.com/konopkov)! - Run stable, named subsystem flush hooks after admitted server work drains and checkpoint the local SQLite WAL before shutdown completes.

- [#171](https://github.com/knpkv/npm/pull/171) [`1c142fb`](https://github.com/knpkv/npm/commit/1c142fb898954970c7b1855c70d019d97bcd76c7) Thanks [@konopkov](https://github.com/konopkov)! - Recover a bounded stable batch of eligible governed actions during startup and include startup synchronization work in graceful-drain accounting.

- [#176](https://github.com/knpkv/npm/pull/176) [`f2c7c3f`](https://github.com/knpkv/npm/commit/f2c7c3fb1acff1907c7c9fbeb613775eab5c5c2b) Thanks [@konopkov](https://github.com/konopkov)! - Add Schema-decoded, size-bounded CodeCommit blob reads with typed provider-limit metadata.

- [#181](https://github.com/knpkv/npm/pull/181) [`665cecb`](https://github.com/knpkv/npm/commit/665cecbc3d5f79f9083acb1b393ace9a8ec0b1b8) Thanks [@konopkov](https://github.com/konopkov)! - Prefer one shared local Atlassian OAuth profile when connecting Jira and Confluence, while retaining API tokens as an explicit fallback.

- [#238](https://github.com/knpkv/npm/pull/238) [`1955699`](https://github.com/knpkv/npm/commit/195569947c4f5c7d7ddb2ad4a8df386b00ca4e85) Thanks [@konopkov](https://github.com/konopkov)! - Complete combined Jira and Confluence OAuth sign-in when Atlassian returns product-specific accessible-resource rows for the same cloud site.

- [#233](https://github.com/knpkv/npm/pull/233) [`c147fea`](https://github.com/knpkv/npm/commit/c147fea8717a16ec5cb8cfce68e8790299c1c58b) Thanks [@konopkov](https://github.com/konopkov)! - Report timed Control Center build phases, avoid forced declaration rebuilds, and scope pre-commit verification to staged Control Center or documentation changes when safe.

- [#156](https://github.com/knpkv/npm/pull/156) [`467fa0c`](https://github.com/knpkv/npm/commit/467fa0c9ce6de4db56080849e334cf7a50cec439) Thanks [@konopkov](https://github.com/konopkov)! - Add a production Clockify time-entry reader backed by the shared Schema-validated client, with stable normalized revisions, bounded paginated user sync, bounded concurrency, typed failures, and explicit read-only scope.

- [#173](https://github.com/knpkv/npm/pull/173) [`e0404e1`](https://github.com/knpkv/npm/commit/e0404e1ced75b22e800c3a7485895d1c724bb6f0) Thanks [@konopkov](https://github.com/konopkov)! - Expire governed-action recovery claims durably during graceful shutdown and let startup recovery reclaim explicitly expired work without waiting for the original lease deadline.

- [#175](https://github.com/knpkv/npm/pull/175) [`3be5925`](https://github.com/knpkv/npm/commit/3be59251f4a3b16996d45464fb8e81f84cdaf2f5) Thanks [@konopkov](https://github.com/konopkov)! - Persist fake synchronization attempts and reconcile crash-left work as interrupted on startup.

- [#174](https://github.com/knpkv/npm/pull/174) [`2342d78`](https://github.com/knpkv/npm/commit/2342d78105d319c43e6210aba5e9b39dc0a6ca04) Thanks [@konopkov](https://github.com/konopkov)! - Show every available first-party service in an empty workspace and open the selected service setup directly.

- [#232](https://github.com/knpkv/npm/pull/232) [`4542a96`](https://github.com/knpkv/npm/commit/4542a961b10fae5aa476693d471ce18f27721c4e) Thanks [@konopkov](https://github.com/konopkov)! - Externalize server runtime dependencies and enforce deterministic raw and gzip budgets for every emitted Control Center JavaScript artifact.

- [#153](https://github.com/knpkv/npm/pull/153) [`79ffdf6`](https://github.com/knpkv/npm/commit/79ffdf63477813ce96eb6fbdc61afdfa139d7af8) Thanks [@konopkov](https://github.com/konopkov)! - Add a production Jira issue-read plugin backed by the shared Schema-validated Jira client, with typed provider failures, bounded interruptible comment and changelog pagination, and normalized issue, activity, and collaborator context.

- [#239](https://github.com/knpkv/npm/pull/239) [`e662b65`](https://github.com/knpkv/npm/commit/e662b657147de56d56e74cacdbceeb5d63cc34e6) Thanks [@konopkov](https://github.com/konopkov)! - Export environment-configured OpenTelemetry traces and logs over OTLP/HTTP so local Control Center runs can be inspected with Motel and other compatible collectors.

- [#165](https://github.com/knpkv/npm/pull/165) [`f67ccd3`](https://github.com/knpkv/npm/commit/f67ccd35147174c3fd2ce299b65c7fa1e3474b89) Thanks [@konopkov](https://github.com/konopkov)! - Make fresh data-root publication and secret-store startup portable to macOS by
  verifying canonical filesystem paths against pinned directory identities instead
  of relying on Linux descriptor path aliases.

- [#178](https://github.com/knpkv/npm/pull/178) [`1545c97`](https://github.com/knpkv/npm/commit/1545c973de314e210030e4d78e94c7caf56a83b9) Thanks [@konopkov](https://github.com/konopkov)! - Keep all installed first-party services visible while authenticated connection details are loading or temporarily unavailable.

- [#226](https://github.com/knpkv/npm/pull/226) [`0df499b`](https://github.com/knpkv/npm/commit/0df499bb3241a4efa9a4179f649233943310f47d) Thanks [@konopkov](https://github.com/konopkov)! - Move live AWS reads to the maintained Effect 4-compatible Distilled AWS package.

- [#170](https://github.com/knpkv/npm/pull/170) [`d4be1a4`](https://github.com/knpkv/npm/commit/d4be1a4bda2dd820aad86673c30aa3344db4920e) Thanks [@konopkov](https://github.com/konopkov)! - Show all first-party services before browser pairing and carry the selected service directly into its setup flow after pairing.

- [#180](https://github.com/knpkv/npm/pull/180) [`63607d5`](https://github.com/knpkv/npm/commit/63607d58e7694b401a1b695a4179e5f1777b260c) Thanks [@konopkov](https://github.com/konopkov)! - Configure one discovered AWS profile and follow multiple CodeCommit repositories and CodePipeline pipelines from the same account-oriented setup form.

- [#186](https://github.com/knpkv/npm/pull/186) [`dd750fa`](https://github.com/knpkv/npm/commit/dd750fa8d0a67020cf5fa38f071fd0bf8c928f33) Thanks [@konopkov](https://github.com/konopkov)! - Group followed repositories and pipelines under their verified provider account in the Services overview.

- Updated dependencies [[`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43), [`41565ba`](https://github.com/knpkv/npm/commit/41565ba9d1adf50abf36620dec1e9dee516f5133), [`459962f`](https://github.com/knpkv/npm/commit/459962f2d71a8d36ffdb5fd4cf1b70d413973445), [`1c142fb`](https://github.com/knpkv/npm/commit/1c142fb898954970c7b1855c70d019d97bcd76c7), [`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43), [`f2c7c3f`](https://github.com/knpkv/npm/commit/f2c7c3fb1acff1907c7c9fbeb613775eab5c5c2b), [`e1d121d`](https://github.com/knpkv/npm/commit/e1d121d5782f756d0a8f271d59a39a3b98f42c38), [`c8df50c`](https://github.com/knpkv/npm/commit/c8df50cf35a05e66b8621a4faacfca53426eb8f1), [`665cecb`](https://github.com/knpkv/npm/commit/665cecbc3d5f79f9083acb1b393ace9a8ec0b1b8), [`4e03e7a`](https://github.com/knpkv/npm/commit/4e03e7ad7302a0fa4993f528fdc07cf7072ef71d), [`7904c3e`](https://github.com/knpkv/npm/commit/7904c3e49e1500f6f42a2c3786d3ff9c76b5fcc4), [`e0404e1`](https://github.com/knpkv/npm/commit/e0404e1ced75b22e800c3a7485895d1c724bb6f0), [`58bb138`](https://github.com/knpkv/npm/commit/58bb138045504ef5e354f873e56ddaee87cfa144), [`3be5925`](https://github.com/knpkv/npm/commit/3be59251f4a3b16996d45464fb8e81f84cdaf2f5), [`0bca514`](https://github.com/knpkv/npm/commit/0bca51411408c30041d966812e75eb7c64d61c2b), [`742072a`](https://github.com/knpkv/npm/commit/742072a2d4359eee512d6e4d525adc51564a1e64), [`c770262`](https://github.com/knpkv/npm/commit/c7702624d7e388f6e9e3cd0dc93845e195737406), [`e966c29`](https://github.com/knpkv/npm/commit/e966c29526522e1eac112533e70e3e39041e3ced), [`933c53b`](https://github.com/knpkv/npm/commit/933c53b22999c5a0c5d4ee91653b76b81e2a6824), [`b350caf`](https://github.com/knpkv/npm/commit/b350caf2ac0328fccc304b1e8211f41475d4339c), [`0df499b`](https://github.com/knpkv/npm/commit/0df499bb3241a4efa9a4179f649233943310f47d), [`c770262`](https://github.com/knpkv/npm/commit/c7702624d7e388f6e9e3cd0dc93845e195737406), [`f820c19`](https://github.com/knpkv/npm/commit/f820c1906e00f2f2d17c2e7cc3921ba26522db43), [`88bc8c8`](https://github.com/knpkv/npm/commit/88bc8c81c9909f26b3e35328559761c98db7f84d), [`c5f2d10`](https://github.com/knpkv/npm/commit/c5f2d103dfa6983c2b28ee6da57151d80d1d503e), [`1bba5c2`](https://github.com/knpkv/npm/commit/1bba5c282684553fbc670e6dcf2960e8a4e200ed), [`c770262`](https://github.com/knpkv/npm/commit/c7702624d7e388f6e9e3cd0dc93845e195737406), [`331e503`](https://github.com/knpkv/npm/commit/331e503f66c249276967a78040fa504d708e0244), [`fe27e3c`](https://github.com/knpkv/npm/commit/fe27e3c74630d52b25d840e10fe8ea58b38b6b65), [`e8a055b`](https://github.com/knpkv/npm/commit/e8a055b0190e4ac4d75716e6e1cbedb6253861a7)]:
  - @knpkv/jira-api-client@1.0.0
  - @knpkv/confluence-api-client@1.0.0
  - @knpkv/confluence-to-markdown@2.1.1
  - @knpkv/codecommit-core@0.9.0
  - @knpkv/control-center-sql@0.1.0
  - @knpkv/clockify-api-client@1.0.0
  - @knpkv/ai-runtime@0.1.0
  - @knpkv/atlassian-common@1.2.0
  - @knpkv/rly@0.1.0
  - @knpkv/ai-claude@0.1.0
  - @knpkv/ai-codex@0.1.0
