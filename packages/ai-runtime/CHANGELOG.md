# @knpkv/ai-runtime

## 0.1.0

### Minor Changes

- [#229](https://github.com/knpkv/npm/pull/229) [`b350caf`](https://github.com/knpkv/npm/commit/b350caf2ac0328fccc304b1e8211f41475d4339c) Thanks [@konopkov](https://github.com/konopkov)! - Add a provider-neutral Effect runtime protocol, terminal-stream validation, opaque continuation references, and a deterministic agent adapter for durable worker tests.

### Patch Changes

- [#231](https://github.com/knpkv/npm/pull/231) [`c8df50c`](https://github.com/knpkv/npm/commit/c8df50cf35a05e66b8621a4faacfca53426eb8f1) Thanks [@konopkov](https://github.com/konopkov)! - Add a provider-neutral durable agent worker that claims one release job, persists validated runtime events and terminal failures, and completes recovered cancellations without relaunching a provider. Make the first validated terminal runtime event authoritative so never-ending provider transports are interrupted promptly.
