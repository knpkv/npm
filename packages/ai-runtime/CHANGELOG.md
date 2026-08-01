# @knpkv/ai-runtime

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
