# @knpkv/herdr-fleet

## 0.4.0

### Minor Changes

- [#419](https://github.com/knpkv/npm/pull/419) [`7b8fddb`](https://github.com/knpkv/npm/commit/7b8fddbabe360b01b2f09d1cc223f04463053949) Thanks [@konopkov](https://github.com/konopkov)! - Expose a scoped hostd operations composer for durable coordinator injection, including crash-safe receipt recovery, bounded terminal summaries, and accepted job identity.

- [#420](https://github.com/knpkv/npm/pull/420) [`3af6bb0`](https://github.com/knpkv/npm/commit/3af6bb0f49806fa651d27aa33db0377fd82f46bb) Thanks [@konopkov](https://github.com/konopkov)! - Harden every durable execution read against command, route, activity-key, linked-parent, orphan-replica, and running-worker binding mismatches before restoring Work authority.

  Add exact-worker recovery replay, queued delivery failure, accepted Work revision and bounded context handoffs, a required `transition_summary` delegate mode, and a typed failed-Luna Sol escalation reference for durable hostd adapters. Preserve valid subset lineages during v1 migration, reject duplicate dispatch replicas and unsupported or malformed persisted handoff versions, validate the complete persisted worker binding, its immutable lane/checkpoint companions, matching handoff goal, exact routed-metadata discriminator, linked terminally failed Luna parent, complete coordinator lifecycle, and a lane head at least as new as the activated binding before restoring revision authority, and validate current v2 dispatch and metadata replicas against the same handoff before readback. Current lane readback also preserves the binding goal, requires an exact immutable operation-ledger replica, and requires the complete claim to remain exact at the binding revision. Reject partial coordinator schemas before either v1 or v2 handoff readback, keep SQL Work DDL inside the fail-closed migration transaction, scope legacy companion reads to the migrated dispatch closure, require every routed Sol dispatch to retain a Work link, validate every modern metadata row against its exact dispatch command, activity key, route discriminator, and Work-link form, reject routed metadata without its dispatch, and require every modern routed dispatch to retain exactly one metadata row. Reject malformed or non-null Luna Work links without charging valid Luna-only history to the Work ledger bound, enforce migrated decision capacity after every legacy upgrade path, and expose stale Sol acceptance as `OrchestratorWorkRevisionConflictError` without a partial dispatch. Routed submissions and durable readback bind `consult` to Luna medium, `transition_summary` to Luna low, and `review` or `work` to Sol high, rejecting persisted command/route mismatches before restoring Work authority. Sol escalation accepts only explicit channel-free `review` and `work` agent-delegate commands. Fleet requires exact persisted-worker replay before recovery can report a terminal result and accepts relationship-free coordinator roots only for consultation and transition summaries.

## 0.3.0

### Minor Changes

- [#404](https://github.com/knpkv/npm/pull/404) [`beed20b`](https://github.com/knpkv/npm/commit/beed20b1255616223d74e244065b560c7407eec2) Thanks [@konopkov](https://github.com/konopkov)! - Add an opt-in read-only LAN Work listener with five-minute browser pairing.

- [#401](https://github.com/knpkv/npm/pull/401) [`be9feff`](https://github.com/knpkv/npm/commit/be9feff762ab43b39c887b39815a2959714d7364) Thanks [@konopkov](https://github.com/konopkov)! - Add a typed LAN Work listener for non-browser clients and route local Work commands through its fixed checkpoint and snapshot endpoints. This typed listener does not provide browser pairing: it intentionally serves only its typed JSON routes, with no same-origin page or cross-origin browser grant.

### Patch Changes

- [#413](https://github.com/knpkv/npm/pull/413) [`43f1174`](https://github.com/knpkv/npm/commit/43f1174633ebba9d6244156fffa23514c89b4c74) Thanks [@konopkov](https://github.com/konopkov)! - Accept the root coordinator as the started worker for coordinator-handled consult and chat jobs while retaining exact child-lineage requirements for delegated work.

## 0.2.0

### Minor Changes

- [#384](https://github.com/knpkv/npm/pull/384) [`ac866e9`](https://github.com/knpkv/npm/commit/ac866e98e1b69f22f63618f9189482a34171edd0) Thanks [@konopkov](https://github.com/konopkov)! - Publish the Herdr fleet protocol, Tailscale adapter, Connect terminal, coordinator chat, durable Work board, and shared approval host runtime as reusable packages.
