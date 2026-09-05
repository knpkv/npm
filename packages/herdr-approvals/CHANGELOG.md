# @knpkv/herdr-approvals

## 0.5.0

### Minor Changes

- [#416](https://github.com/knpkv/npm/pull/416) [`c85331a`](https://github.com/knpkv/npm/commit/c85331a01e77941fc0ac3fd952ddf2e471e38277) Thanks [@konopkov](https://github.com/konopkov)! - Link connected Herdr agents to their associated Work goals.

- [#417](https://github.com/knpkv/npm/pull/417) [`d436f2a`](https://github.com/knpkv/npm/commit/d436f2a58430254a8f37b271b25de1830ea15e5b) Thanks [@konopkov](https://github.com/konopkov)! - Add live durable orchestration events, exact-head PR evidence, executable route lookup, atomic Sol-to-Work lineage binding, and an atomic replay-safe worker-start binding that persists the worker identity and Connect target under lane revision authority. Keep completed goals out of Connect association and keep a LAN Work pairing code usable when session-token issuance fails before its atomic consume.

- [#406](https://github.com/knpkv/npm/pull/406) [`7602437`](https://github.com/knpkv/npm/commit/760243717e7d09adb74816d521a85b89c08a5dc5) Thanks [@konopkov](https://github.com/konopkov)! - Show a redacted, expandable approval request in pending and decision history views.

- [#419](https://github.com/knpkv/npm/pull/419) [`7b8fddb`](https://github.com/knpkv/npm/commit/7b8fddbabe360b01b2f09d1cc223f04463053949) Thanks [@konopkov](https://github.com/konopkov)! - Expose a scoped hostd operations composer for durable coordinator injection, including crash-safe receipt recovery, bounded terminal summaries, and accepted job identity.

- [#420](https://github.com/knpkv/npm/pull/420) [`3af6bb0`](https://github.com/knpkv/npm/commit/3af6bb0f49806fa651d27aa33db0377fd82f46bb) Thanks [@konopkov](https://github.com/konopkov)! - Harden every durable execution read against command, route, activity-key, linked-parent, orphan-replica, and running-worker binding mismatches before restoring Work authority.

  Add exact-worker recovery replay, queued delivery failure, accepted Work revision and bounded context handoffs, a required `transition_summary` delegate mode, and a typed failed-Luna Sol escalation reference for durable hostd adapters. Preserve valid subset lineages during v1 migration, reject duplicate dispatch replicas and unsupported or malformed persisted handoff versions, validate the complete persisted worker binding, its immutable lane/checkpoint companions, matching handoff goal, exact routed-metadata discriminator, linked terminally failed Luna parent, complete coordinator lifecycle, and a lane head at least as new as the activated binding before restoring revision authority, and validate current v2 dispatch and metadata replicas against the same handoff before readback. Current lane readback also preserves the binding goal, requires an exact immutable operation-ledger replica, and requires the complete claim to remain exact at the binding revision. Reject partial coordinator schemas before either v1 or v2 handoff readback, keep SQL Work DDL inside the fail-closed migration transaction, scope legacy companion reads to the migrated dispatch closure, require every routed Sol dispatch to retain a Work link, validate every modern metadata row against its exact dispatch command, activity key, route discriminator, and Work-link form, reject routed metadata without its dispatch, and require every modern routed dispatch to retain exactly one metadata row. Reject malformed or non-null Luna Work links without charging valid Luna-only history to the Work ledger bound, enforce migrated decision capacity after every legacy upgrade path, and expose stale Sol acceptance as `OrchestratorWorkRevisionConflictError` without a partial dispatch. Routed submissions and durable readback bind `consult` to Luna medium, `transition_summary` to Luna low, and `review` or `work` to Sol high, rejecting persisted command/route mismatches before restoring Work authority. Sol escalation accepts only explicit channel-free `review` and `work` agent-delegate commands. Fleet requires exact persisted-worker replay before recovery can report a terminal result and accepts relationship-free coordinator roots only for consultation and transition summaries.

### Patch Changes

- Updated dependencies [[`17df0ad`](https://github.com/knpkv/npm/commit/17df0ad67dcf339d0d9541656be1ce236c3e34a2), [`c85331a`](https://github.com/knpkv/npm/commit/c85331a01e77941fc0ac3fd952ddf2e471e38277), [`d436f2a`](https://github.com/knpkv/npm/commit/d436f2a58430254a8f37b271b25de1830ea15e5b), [`7b8fddb`](https://github.com/knpkv/npm/commit/7b8fddbabe360b01b2f09d1cc223f04463053949), [`3af6bb0`](https://github.com/knpkv/npm/commit/3af6bb0f49806fa651d27aa33db0377fd82f46bb), [`bd51a53`](https://github.com/knpkv/npm/commit/bd51a5316452fd24dd6352399bf11a764c3ca401)]:
  - @knpkv/herdr-connect@0.4.0
  - @knpkv/herdr-work@0.5.0
  - @knpkv/herdr-coordinator@0.3.0
  - @knpkv/herdr-fleet@0.4.0

## 0.4.0

### Minor Changes

- [#404](https://github.com/knpkv/npm/pull/404) [`beed20b`](https://github.com/knpkv/npm/commit/beed20b1255616223d74e244065b560c7407eec2) Thanks [@konopkov](https://github.com/konopkov)! - Add an opt-in read-only LAN Work listener with five-minute browser pairing.

- [#401](https://github.com/knpkv/npm/pull/401) [`be9feff`](https://github.com/knpkv/npm/commit/be9feff762ab43b39c887b39815a2959714d7364) Thanks [@konopkov](https://github.com/konopkov)! - Add a typed LAN Work listener for non-browser clients and route local Work commands through its fixed checkpoint and snapshot endpoints. This typed listener does not provide browser pairing: it intentionally serves only its typed JSON routes, with no same-origin page or cross-origin browser grant.

- [#407](https://github.com/knpkv/npm/pull/407) [`cf83d20`](https://github.com/knpkv/npm/commit/cf83d20883d8eca0bc1fcddeb0632a94c947a238) Thanks [@konopkov](https://github.com/konopkov)! - Harden the typed Work record and snapshot bridge with structural replay idempotency and fail-closed response decoding.

### Patch Changes

- Updated dependencies [[`1800d52`](https://github.com/knpkv/npm/commit/1800d528024607ef63dbfd0cd8a92a8b8622f783), [`beed20b`](https://github.com/knpkv/npm/commit/beed20b1255616223d74e244065b560c7407eec2), [`43f1174`](https://github.com/knpkv/npm/commit/43f1174633ebba9d6244156fffa23514c89b4c74), [`1dcc473`](https://github.com/knpkv/npm/commit/1dcc473ebd14c2a4ac00d7fd67bf9a8d80201f66), [`be9feff`](https://github.com/knpkv/npm/commit/be9feff762ab43b39c887b39815a2959714d7364), [`cf83d20`](https://github.com/knpkv/npm/commit/cf83d20883d8eca0bc1fcddeb0632a94c947a238)]:
  - @knpkv/herdr-work@0.4.0
  - @knpkv/herdr-fleet@0.3.0
  - @knpkv/rly@0.5.1
  - @knpkv/herdr-connect@0.3.1
  - @knpkv/herdr-coordinator@0.2.1

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
