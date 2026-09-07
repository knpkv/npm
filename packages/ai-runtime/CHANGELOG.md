# @knpkv/ai-runtime

## 0.4.0

### Minor Changes

- [#380](https://github.com/knpkv/npm/pull/380) [`8caea60`](https://github.com/knpkv/npm/commit/8caea601c147b8a1dd0ea9f20155f4e76ff6351e) Thanks [@konopkov](https://github.com/konopkov)! - Open shared CodeCommit pull-request links as durable, release-independent Control Center reviews, show stale-head and per-run usage state, explain validated changes as ordered cohorts and layers, and route both applications through a loopback-only deterministic CodeCommit mock for local review-cycle testing.

- [#382](https://github.com/knpkv/npm/pull/382) [`94ee004`](https://github.com/knpkv/npm/commit/94ee00487f0595cdc16fd8f1332689eb39ecfaf2) Thanks [@konopkov](https://github.com/konopkov)! - Run release-independent CodeCommit reviews through authenticated native Codex sandboxes, resolve AWS SSO profiles safely, preserve redacted review failure stages and causes, and make review setup, settings, service health, and narrow-screen navigation clearer.
  Review activity now scrolls independently, follows new output without stealing a reader's position, and keeps a multiline draft composer available while a run is active.

## 0.3.1

### Patch Changes

- [#361](https://github.com/knpkv/npm/pull/361) [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade the workspace to Effect 4.0.0-rc.109, pin the vendored Effect reference to that exact upstream release, guard source/package alignment, and bound Control Center test concurrency for reliable CI execution.

## 0.3.0

### Minor Changes

- [#363](https://github.com/knpkv/npm/pull/363) [`316c383`](https://github.com/knpkv/npm/commit/316c3832c64ce159b7b18d9be3d58bf355c20b8a) Thanks [@konopkov](https://github.com/konopkov)! - Require Node.js 26 or newer and align the reproducible development, CI, release,
  benchmark, and package-validation toolchains with Node.js 26.

  Keep the CodeCommit CLI on the current Bun runtime, document that executable
  prerequisite, and require its Bun-hosted process boundaries in CI.

- [#370](https://github.com/knpkv/npm/pull/370) [`27d2ca1`](https://github.com/knpkv/npm/commit/27d2ca18b0c0b0f8a252d461c0aaf10eb92e9ffc) Thanks [@konopkov](https://github.com/konopkov)! - Enforce the complete anti-slop rule set with zero accepted diagnostics and update affected APIs and implementations to satisfy the required contracts.

### Patch Changes

- [#361](https://github.com/knpkv/npm/pull/361) [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2) Thanks [@konopkov](https://github.com/konopkov)! - Update Effect and effect-qb, migrate schema-tagged errors to the current Effect API, and adopt the dialect-scoped SQLite function and type APIs introduced by effect-qb 0.22.

## 0.2.1

### Patch Changes

- [#343](https://github.com/knpkv/npm/pull/343) [`4def7db`](https://github.com/knpkv/npm/commit/4def7db2f400cf68218262994d67ed90a7154bf1) Thanks [@konopkov](https://github.com/konopkov)! - Align runtime ownership, cancellation, caching, time, failure handling, polling,
  decoding, and executable entrypoints with Effect v4 idioms. Expose clock-injected
  Atlassian token construction and expiry helpers, and enable workspace-wide
  Effect diagnostics and prevention checks.

## 0.2.0

### Minor Changes

- [#294](https://github.com/knpkv/npm/pull/294) [`0868397`](https://github.com/knpkv/npm/commit/08683978ea4805f5768e8c5b7e09b6e1e6d3db60) Thanks [@konopkov](https://github.com/konopkov)! - Capture bounded, credential-free local CLI implementation and version metadata
  through Effect Process, persist it with durable agent run starts, and show it
  in pull-request Review Thread activity.

- [#286](https://github.com/knpkv/npm/pull/286) [`f804a4f`](https://github.com/knpkv/npm/commit/f804a4f3f9424218363ce88b0354c06cbb3c811f) Thanks [@konopkov](https://github.com/konopkov)! - Add a stateless provider-neutral structured tool loop with typed Effect AI tool execution, streamed activity and usage, one schema-guided repair, cancellation and budget enforcement, 64 KiB artifact-backed tool results, validated final output, deterministic model tests, and an adapter for the existing durable runtime contract.

## 0.1.0

### Minor Changes

- [#229](https://github.com/knpkv/npm/pull/229) [`b350caf`](https://github.com/knpkv/npm/commit/b350caf2ac0328fccc304b1e8211f41475d4339c) Thanks [@konopkov](https://github.com/konopkov)! - Add a provider-neutral Effect runtime protocol, terminal-stream validation, opaque continuation references, and a deterministic agent adapter for durable worker tests.

### Patch Changes

- [#231](https://github.com/knpkv/npm/pull/231) [`c8df50c`](https://github.com/knpkv/npm/commit/c8df50cf35a05e66b8621a4faacfca53426eb8f1) Thanks [@konopkov](https://github.com/konopkov)! - Add a provider-neutral durable agent worker that claims one release job, persists validated runtime events and terminal failures, and completes recovered cancellations without relaunching a provider. Make the first validated terminal runtime event authoritative so never-ending provider transports are interrupted promptly.
