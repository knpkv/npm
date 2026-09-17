# @knpkv/control-center-sql

## 0.4.0

### Minor Changes

- [#380](https://github.com/knpkv/npm/pull/380) [`8caea60`](https://github.com/knpkv/npm/commit/8caea601c147b8a1dd0ea9f20155f4e76ff6351e) Thanks [@konopkov](https://github.com/konopkov)! - Open shared CodeCommit pull-request links as durable, release-independent Control Center reviews, show stale-head and per-run usage state, explain validated changes as ordered cohorts and layers, and route both applications through a loopback-only deterministic CodeCommit mock for local review-cycle testing.

## 0.3.1

### Patch Changes

- [#361](https://github.com/knpkv/npm/pull/361) [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade the workspace to Effect 4.0.0-rc.109, pin the vendored Effect reference to that exact upstream release, guard source/package alignment, and bound Control Center test concurrency for reliable CI execution.

## 0.3.0

### Minor Changes

- [#363](https://github.com/knpkv/npm/pull/363) [`316c383`](https://github.com/knpkv/npm/commit/316c3832c64ce159b7b18d9be3d58bf355c20b8a) Thanks [@konopkov](https://github.com/konopkov)! - Require Node.js 26 or newer and align the reproducible development, CI, release,
  benchmark, and package-validation toolchains with Node.js 26.

  Keep the CodeCommit CLI on the current Bun runtime, document that executable
  prerequisite, and require its Bun-hosted process boundaries in CI.

### Patch Changes

- [#361](https://github.com/knpkv/npm/pull/361) [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2) Thanks [@konopkov](https://github.com/konopkov)! - Update Effect and effect-qb, migrate schema-tagged errors to the current Effect API, and adopt the dialect-scoped SQLite function and type APIs introduced by effect-qb 0.22.

## 0.2.1

### Patch Changes

- [#319](https://github.com/knpkv/npm/pull/319) [`4d06229`](https://github.com/knpkv/npm/commit/4d062295393add7a6f34059041aec01403f92d4d) Thanks [@konopkov](https://github.com/konopkov)! - Add durable agent edit and targeted revalidation jobs for immutable pull-request review suggestions.

## 0.2.0

### Minor Changes

- [#270](https://github.com/knpkv/npm/pull/270) [`f7ffb0f`](https://github.com/knpkv/npm/commit/f7ffb0f834bf368598019fe7b3c1e05029c8a88e) Thanks [@konopkov](https://github.com/konopkov)! - Add host-side pull-request review orchestration that routes an explicitly selected Effect AI model through typed sbx tools, validates structured suggestions against exact added-line evidence, derives stable identities before durable persistence, and keeps release-chat workers independent from opt-in sandbox configuration. Add task-scoped agent-job dispatch query inputs to the SQL package.

- [#271](https://github.com/knpkv/npm/pull/271) [`30eda5a`](https://github.com/knpkv/npm/commit/30eda5a171909a1c3339a8d5307771a1f14401c7) Thanks [@konopkov](https://github.com/konopkov)! - Add authenticated exact-head pull-request review state and enqueue APIs, durable latest-review lookup, provider capability discovery, and a compact PR-page review surface for pending, failed, and completed findings. Split the agent API contract into its own lazy browser chunk so the generated client remains within its enforced artifact budget.

- [#292](https://github.com/knpkv/npm/pull/292) [`33c07d3`](https://github.com/knpkv/npm/commit/33c07d35c98464ba2ec3af925057b6e660851786) Thanks [@konopkov](https://github.com/konopkov)! - Give each CodeCommit pull request one durable review thread across changing
  heads. Persist bounded prior-run context into immutable review jobs, expose
  cursor-paged browser-safe activity, and let the Local Operator launch targeted
  follow-up reviews from the pull-request UI.

- [#295](https://github.com/knpkv/npm/pull/295) [`6b46053`](https://github.com/knpkv/npm/commit/6b460535e9bc7f4df6704dc053411f9a3aa5aa70) Thanks [@konopkov](https://github.com/konopkov)! - Let operators page backward through durable pull-request review activity while
  live updates continue from an independent tail cursor.

- [#293](https://github.com/knpkv/npm/pull/293) [`5528922`](https://github.com/knpkv/npm/commit/5528922b052bece4fe782b170cc80dd7bd6230d9) Thanks [@konopkov](https://github.com/konopkov)! - Let pull-request review agents page bounded projections of prior durable thread
  events through a cursor API fenced before the current immutable run.

- [#267](https://github.com/knpkv/npm/pull/267) [`e0d7e9a`](https://github.com/knpkv/npm/commit/e0d7e9a4153a97f3cedaac3b41e7e2790170317c) Thanks [@konopkov](https://github.com/konopkov)! - Add bounded, durable pull-request review task results with structured prevention proposals.

- [#289](https://github.com/knpkv/npm/pull/289) [`1bb31f5`](https://github.com/knpkv/npm/commit/1bb31f51e4df1aa12e760aa8db99cf459e680dac) Thanks [@konopkov](https://github.com/konopkov)! - Replace the capped analyzer report with an sbx-only full-project Review Agent
  flow. Launches now disclose the exact head, Review Agent Profile, budget,
  blocked network, and sandbox; Effect AI models explore through typed sandbox
  tools; only schema-valid suggestions anchored to exact added-line evidence are
  persisted and rendered inline. Control Center derives the review outcome and
  retains bounded live exploration activity. Include the durable thread identity
  in latest-review SQL projections.

- [#290](https://github.com/knpkv/npm/pull/290) [`b97fd1b`](https://github.com/knpkv/npm/commit/b97fd1b2433bcaef600e5470e2ce92d7edc71f94) Thanks [@konopkov](https://github.com/konopkov)! - Add human-confirmed publication of agent review suggestions as exact-line CodeCommit comments, including AWS identity and immutable revision previews, editable content, durable governed-action receipts, retry-safe idempotency recovery, and the corresponding operator UI. Preserve inline review locations in the CodeCommit action contract and add a typed effect-qb lookup for governed action recovery.

## 0.1.0

### Minor Changes

- [#247](https://github.com/knpkv/npm/pull/247) [`4e03e7a`](https://github.com/knpkv/npm/commit/4e03e7ad7302a0fa4993f528fdc07cf7072ef71d) Thanks [@konopkov](https://github.com/konopkov)! - Add a canonical full-page route for normalized workspace entities with exact
  origin restoration, provenance, freshness, collaborators, bounded delivery
  relationships, attributable activity, and contextual agent entry. Back the
  page with an authorized typed entity read model and effect-qb query plans.

- [#234](https://github.com/knpkv/npm/pull/234) [`7904c3e`](https://github.com/knpkv/npm/commit/7904c3e49e1500f6f42a2c3786d3ff9c76b5fcc4) Thanks [@konopkov](https://github.com/konopkov)! - Add durable release-scoped agent threads, transactional job attempts and leases, bounded event replay, and effect-qb claim and recovery plans.

- [#155](https://github.com/knpkv/npm/pull/155) [`58bb138`](https://github.com/knpkv/npm/commit/58bb138045504ef5e354f873e56ddaee87cfa144) Thanks [@konopkov](https://github.com/konopkov)! - Replace portfolio readiness N+1 reads with one bounded, parameterized
  `effect-qb` query plan while retaining Schema decoding, materialization
  verification, and malformed-row quarantine.

  Reset prototype persistence to one exact unstable schema snapshot. Historical
  migrations and the migration ledger are intentionally removed until the data
  model is stable and released databases require forward upgrades.

- [#236](https://github.com/knpkv/npm/pull/236) [`742072a`](https://github.com/knpkv/npm/commit/742072a2d4359eee512d6e4d525adc51564a1e64) Thanks [@konopkov](https://github.com/konopkov)! - Add an atomic, replay-safe application seam that commits normalized plugin pages
  and materializes their accepted people, entities, tombstones, evidence, and
  relationships into the canonical delivery graph used by Items.

- [#157](https://github.com/knpkv/npm/pull/157) [`933c53b`](https://github.com/knpkv/npm/commit/933c53b22999c5a0c5d4ee91653b76b81e2a6824) Thanks [@konopkov](https://github.com/konopkov)! - Add a default-redacted, stable-paginated workspace Timeline across governed
  actions, plugin syncs, delivery relationships, and durable system events. Render
  its bounded persistence reads with private `effect-qb` plans and expose a compact
  agent-aware workspace view with actor and UTC date filters.

- [#184](https://github.com/knpkv/npm/pull/184) [`88bc8c8`](https://github.com/knpkv/npm/commit/88bc8c81c9909f26b3e35328559761c98db7f84d) Thanks [@konopkov](https://github.com/konopkov)! - Bind executable plugin connections to followed resources under a shared provider account, with database-enforced service and ownership invariants.

- [#183](https://github.com/knpkv/npm/pull/183) [`c5f2d10`](https://github.com/knpkv/npm/commit/c5f2d103dfa6983c2b28ee6da57151d80d1d503e) Thanks [@konopkov](https://github.com/konopkov)! - Add first-class provider accounts and independently followed resources, including an AWS account shared by multiple CodeCommit repositories and CodePipeline pipelines.

- [#161](https://github.com/knpkv/npm/pull/161) [`e8a055b`](https://github.com/knpkv/npm/commit/e8a055b0190e4ac4d75716e6e1cbedb6253861a7) Thanks [@konopkov](https://github.com/konopkov)! - Add an owner-only exact Timeline event detail endpoint that exposes durable
  identifiers and agent-job attribution without weakening default page redaction.

### Patch Changes

- [#171](https://github.com/knpkv/npm/pull/171) [`1c142fb`](https://github.com/knpkv/npm/commit/1c142fb898954970c7b1855c70d019d97bcd76c7) Thanks [@konopkov](https://github.com/konopkov)! - Recover a bounded stable batch of eligible governed actions during startup and include startup synchronization work in graceful-drain accounting.

- [#173](https://github.com/knpkv/npm/pull/173) [`e0404e1`](https://github.com/knpkv/npm/commit/e0404e1ced75b22e800c3a7485895d1c724bb6f0) Thanks [@konopkov](https://github.com/konopkov)! - Expire governed-action recovery claims durably during graceful shutdown and let startup recovery reclaim explicitly expired work without waiting for the original lease deadline.

- [#175](https://github.com/knpkv/npm/pull/175) [`3be5925`](https://github.com/knpkv/npm/commit/3be59251f4a3b16996d45464fb8e81f84cdaf2f5) Thanks [@konopkov](https://github.com/konopkov)! - Persist fake synchronization attempts and reconcile crash-left work as interrupted on startup.

- [#237](https://github.com/knpkv/npm/pull/237) [`0bca514`](https://github.com/knpkv/npm/commit/0bca51411408c30041d966812e75eb7c64d61c2b) Thanks [@konopkov](https://github.com/konopkov)! - Add owner-triggered bounded synchronization for CodeCommit, CodePipeline, and Clockify connections, with durable attempt state and canonical Items and Timeline materialization. State reads remain observational, crash-left attempts reconcile when an owner starts the next synchronization, and a full 100-page invocation records successful checkpoint progress for the next run.
