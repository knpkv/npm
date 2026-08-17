# @knpkv/ai-claude

## 0.2.1

### Patch Changes

- [#361](https://github.com/knpkv/npm/pull/361) [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade the workspace to Effect 4.0.0-rc.109, pin the vendored Effect reference to that exact upstream release, guard source/package alignment, and bound Control Center test concurrency for reliable CI execution.

## 0.2.0

### Minor Changes

- [#363](https://github.com/knpkv/npm/pull/363) [`316c383`](https://github.com/knpkv/npm/commit/316c3832c64ce159b7b18d9be3d58bf355c20b8a) Thanks [@konopkov](https://github.com/konopkov)! - Require Node.js 26 or newer and align the reproducible development, CI, release,
  benchmark, and package-validation toolchains with Node.js 26.

  Keep the CodeCommit CLI on the current Bun runtime, document that executable
  prerequisite, and require its Bun-hosted process boundaries in CI.

- [#370](https://github.com/knpkv/npm/pull/370) [`27d2ca1`](https://github.com/knpkv/npm/commit/27d2ca18b0c0b0f8a252d461c0aaf10eb92e9ffc) Thanks [@konopkov](https://github.com/konopkov)! - Enforce the complete anti-slop rule set with zero accepted diagnostics and update affected APIs and implementations to satisfy the required contracts.

### Patch Changes

- [#361](https://github.com/knpkv/npm/pull/361) [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2) Thanks [@konopkov](https://github.com/konopkov)! - Update Effect and effect-qb, migrate schema-tagged errors to the current Effect API, and adopt the dialect-scoped SQLite function and type APIs introduced by effect-qb 0.22.

## 0.1.0

### Minor Changes

- [#126](https://github.com/knpkv/npm/pull/126) [`c770262`](https://github.com/knpkv/npm/commit/c7702624d7e388f6e9e3cd0dc93845e195737406) Thanks [@konopkov](https://github.com/konopkov)! - Add Effect AI-compatible language model providers for authenticated local Claude Code and Codex CLI installations. The Codex adapter also exposes a bounded, cancellation-safe stream of validated native JSONL events for progress and tool-call observability.
