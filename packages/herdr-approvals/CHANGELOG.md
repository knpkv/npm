# @knpkv/herdr-approvals

## 0.3.0

### Minor Changes

- [#398](https://github.com/knpkv/npm/pull/398) [`929b851`](https://github.com/knpkv/npm/commit/929b851d6fa105e326ebb6ee66325978dd124fd5) Thanks [@konopkov](https://github.com/konopkov)! - Add stable form identities for the Work activity search and Connect terminal inputs.

- [#392](https://github.com/knpkv/npm/pull/392) [`da8c8c0`](https://github.com/knpkv/npm/commit/da8c8c08b144a2ea8dfd837ecfa433cae1ad13a7) Thanks [@konopkov](https://github.com/konopkov)! - Bind persisted Work approval targets to the configured approval page origin before recording them.

### Patch Changes

- Updated dependencies [[`da8c8c0`](https://github.com/knpkv/npm/commit/da8c8c08b144a2ea8dfd837ecfa433cae1ad13a7), [`75ece0a`](https://github.com/knpkv/npm/commit/75ece0ab3d666488bc32820aeef56adb0873cead), [`75ece0a`](https://github.com/knpkv/npm/commit/75ece0ab3d666488bc32820aeef56adb0873cead), [`929b851`](https://github.com/knpkv/npm/commit/929b851d6fa105e326ebb6ee66325978dd124fd5)]:
  - @knpkv/herdr-work@0.3.0
  - @knpkv/herdr-connect@0.3.0
  - @knpkv/rly@0.5.0

## 0.2.0

### Minor Changes

- [#384](https://github.com/knpkv/npm/pull/384) [`ac866e9`](https://github.com/knpkv/npm/commit/ac866e98e1b69f22f63618f9189482a34171edd0) Thanks [@konopkov](https://github.com/konopkov)! - Publish the Herdr fleet protocol, Tailscale adapter, Connect terminal, coordinator chat, durable Work board, and shared approval host runtime as reusable packages.

- [#388](https://github.com/knpkv/npm/pull/388) [`182cdbc`](https://github.com/knpkv/npm/commit/182cdbcaa20824c95763b9ddc0695f1ec6ae5ace) Thanks [@konopkov](https://github.com/konopkov)! - Make Work checkpoint recording loopback-only, idempotent for exact replays, and available through `fleetctl work snapshot`.

### Patch Changes

- [#389](https://github.com/knpkv/npm/pull/389) [`618325b`](https://github.com/knpkv/npm/commit/618325b3f61d48ffaa7efef223e987e45493b6f4) Thanks [@konopkov](https://github.com/konopkov)! - Ignore recognized Herdr launch-pending inventory entries while keeping unknown malformed entries strict.
- Updated dependencies [[`ac866e9`](https://github.com/knpkv/npm/commit/ac866e98e1b69f22f63618f9189482a34171edd0), [`3d72330`](https://github.com/knpkv/npm/commit/3d72330d69ce0309436c470d8ba4557c7bfa6edf), [`182cdbc`](https://github.com/knpkv/npm/commit/182cdbcaa20824c95763b9ddc0695f1ec6ae5ace), [`94ee004`](https://github.com/knpkv/npm/commit/94ee00487f0595cdc16fd8f1332689eb39ecfaf2)]:
  - @knpkv/herdr-connect@0.2.0
  - @knpkv/herdr-coordinator@0.2.0
  - @knpkv/herdr-fleet@0.2.0
  - @knpkv/herdr-tailscale@0.2.0
  - @knpkv/herdr-work@0.2.0
  - @knpkv/rly@0.4.1
