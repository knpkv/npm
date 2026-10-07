# @knpkv/herdr-approvals

## 0.9.0

### Minor Changes

- [#548](https://github.com/knpkv/npm/pull/548) [`0125a64`](https://github.com/knpkv/npm/commit/0125a6414d23989eae1d89ab0523dd09a1a7b5e1) Thanks [@konopkov](https://github.com/konopkov)! - Connect knows where a terminal is really scrolled to. The hub reads herdr's scroll position for the open pane (at most twice a second per session and ten times a second across the host) and sends it to the browser, so a pane someone left scrolled back opens with "Older output, N lines back", and Latest returns in exactly that many lines, one command per frame, until a fresh reading says the pane is at the bottom. Readings are taken only while no scroll is in flight and carry the number of scrolls they cover, so the browser uses only those that already include every scroll it sent. Hosts send it only to clients that ask for it, so hubs and hosts can be upgraded in any order. When the position can't be read it is shown as unknown, never as the bottom, and Connect falls back to its previous behaviour.

### Patch Changes

- [#575](https://github.com/knpkv/npm/pull/575) [`655f010`](https://github.com/knpkv/npm/commit/655f010c2bb14b4118d81c60025ac64006b73f1c) Thanks [@konopkov](https://github.com/konopkov)! - Focus rings match rly's: a solid 2px outline in the focus colour, 2px outside the control, from `--rly-focus-ring-width` and `--rly-focus-ring-offset`. Hand-rolled 1px to 3px rings, rings in agent, service or text colours, tinted halos and box-shadow rings are gone. Rings inside clipped containers pull the ring width inside.
- Updated dependencies [[`0125a64`](https://github.com/knpkv/npm/commit/0125a6414d23989eae1d89ab0523dd09a1a7b5e1), [`655f010`](https://github.com/knpkv/npm/commit/655f010c2bb14b4118d81c60025ac64006b73f1c), [`4965043`](https://github.com/knpkv/npm/commit/4965043541a324f630b847ed4d852b6722f6efe6)]:
  - @knpkv/herdr-connect@0.7.0
  - @knpkv/herdr-work@0.7.2
  - @knpkv/rly@0.12.0

## 0.8.0

### Minor Changes

- [#572](https://github.com/knpkv/npm/pull/572) [`74429d4`](https://github.com/knpkv/npm/commit/74429d4719b471ab7aaae230ad594f6c5e1755fb) Thanks [@konopkov](https://github.com/konopkov)! - The hostd composer receives `startedWorker(jobId)`, the worker Fleet's job record says that job started, or null when the job is unknown or started none. A background writer that acts on an agent can check its identity against this record instead of pane metadata, which any local agent can write. A job store that can't be read, or a composition without one, fails with `FleetStoreError`, never null.

### Patch Changes

- [#559](https://github.com/knpkv/npm/pull/559) [`8171e47`](https://github.com/knpkv/npm/commit/8171e47d54136a7f1b48572e3fc5c5a184bc7250) Thanks [@konopkov](https://github.com/konopkov)! - `fleetctl submit HOST work.* <json>` says what is wrong with the payload, in one line: each failing field and what it expected, for example `work.abandon payload: goalId: Missing key; reason: Expected string`. The payload's `kind` may be left out; it is the command's own. Before, any problem printed only "work.abandon payload is invalid".

- [#557](https://github.com/knpkv/npm/pull/557) [`d215ab8`](https://github.com/knpkv/npm/commit/d215ab87781bd00f9199f3c04b0c3a901075efbb) Thanks [@konopkov](https://github.com/konopkov)! - The coordinator chat no longer shows a hard-coded host name or a "Persistent" chip; turns read "You asked" or "You asked for work" with their state as a word, and the scrolling history is a named log a keyboard can reach. The notifications panel explains a blocked or unsupported browser instead of offering an Enable button that cannot work, names the cause when checking fails, and keeps its setup help inside the panel.
- Updated dependencies [[`d215ab8`](https://github.com/knpkv/npm/commit/d215ab87781bd00f9199f3c04b0c3a901075efbb), [`6d215b2`](https://github.com/knpkv/npm/commit/6d215b2fa9bb3e98f447efbbddcb299c41a4efc5)]:
  - @knpkv/herdr-connect@0.6.0
  - @knpkv/rly@0.11.0
  - @knpkv/herdr-work@0.7.1

## 0.7.0

### Minor Changes

- [#544](https://github.com/knpkv/npm/pull/544) [`6971fa1`](https://github.com/knpkv/npm/commit/6971fa10f21e1ec2739d2f9b83ecb63b8de74b47) Thanks [@konopkov](https://github.com/konopkov)! - The default operations now run `nix.apply` as the apply command followed by the ref and then the Fleet job id, so the apply command can record that job's own outcome. A host that restarts mid-apply can then settle the job from that record. An apply command that takes only the ref must ignore the second argument.

### Patch Changes

- [#529](https://github.com/knpkv/npm/pull/529) [`b791563`](https://github.com/knpkv/npm/commit/b791563a328c0118c2716bda59294f7c606225c8) Thanks [@konopkov](https://github.com/konopkov)! - `fleetctl --help`, `fleetctl help` and `fleetctl work --help` now print plain usage and exit 0, even on a machine without a fleet configuration. A mistake now gets one line naming its cause, and a non-zero exit. That covers an unknown command, missing arguments, an unknown host (the line lists the known hosts) and an unknown job kind (it lists the kinds). Usage mistakes print the usage that applies after that line, with no `FleetValidationError:` prefix. A missing configuration file is reported as `no fleet configuration at PATH; create it, or set FLEET_CONFIG_PATH to an existing file` instead of a platform error.
- Updated dependencies [[`d183858`](https://github.com/knpkv/npm/commit/d1838583e51cd683e167d6cb735ebbfe552bdb7f), [`21ab62a`](https://github.com/knpkv/npm/commit/21ab62a25400f61f27a5230553e4d4780034b899), [`b791563`](https://github.com/knpkv/npm/commit/b791563a328c0118c2716bda59294f7c606225c8), [`d266e4c`](https://github.com/knpkv/npm/commit/d266e4cccb601e0d8006ce50e48743b8f347f21e), [`c93baf2`](https://github.com/knpkv/npm/commit/c93baf29bba9d67ffc4938ce0b0ada533260fddc)]:
  - @knpkv/herdr-connect@0.5.0
  - @knpkv/herdr-fleet@0.6.1
  - @knpkv/herdr-work@0.7.0
  - @knpkv/rly@0.10.0
  - @knpkv/herdr-coordinator@0.3.3

## 0.6.0

### Minor Changes

- [#517](https://github.com/knpkv/npm/pull/517) [`a2d8fb6`](https://github.com/knpkv/npm/commit/a2d8fb6bbd629c6cef3238150c47f42d0835e29b) Thanks [@konopkov](https://github.com/konopkov)! - Hostd composers receive `hasOutstandingWorkJob`: whether any Work job in hostd's job store is still to run (pending approval, queued or running), so a background Work writer can defer its writes and keep pending approvals valid. `makeHostdOperations` takes the job store as an optional third argument, and `makeHostdProgram` now opens the job store before composing operations.

- [#523](https://github.com/knpkv/npm/pull/523) [`38c8af6`](https://github.com/knpkv/npm/commit/38c8af6a0094a1ebb5c6e673c74dc40c5733283f) Thanks [@konopkov](https://github.com/konopkov)! - New approval-bound `work.abandon` job, which moves one Work goal to `abandoned`. The payload names the goal, its exact owner, a reason and the goal's expected head. The job hash covers every field, and the job always needs approval. `WorkService.abandon` clears the blocker and records a status activity naming the approved job. It refuses a goal with an active lane (`WorkGoalLaneActiveError`, naming the lane), a goal that has already finished (`WorkGoalTerminalError`), a stale head and a different owner. An exact replay returns the stored result. `runWorkAbandon` executes the job only with a persisted approval. The hub shows its fields, history and dashboard label, and `fleetctl submit HOST work.abandon PAYLOAD_JSON` submits it.

### Patch Changes

- Updated dependencies [[`bf3eb59`](https://github.com/knpkv/npm/commit/bf3eb599a06c5e6c2e7228ce4aaebd9d27f50ee9), [`934843b`](https://github.com/knpkv/npm/commit/934843bbcea57cbf3266fce950c020733046cac1), [`148daa6`](https://github.com/knpkv/npm/commit/148daa6be147dca74bc642bd552b603deb760eae), [`4e8f346`](https://github.com/knpkv/npm/commit/4e8f346b926b859ea2b3be07ec7dc6cb77ca8e76), [`e57bb6d`](https://github.com/knpkv/npm/commit/e57bb6db1b393dbff8e116573cf2db23992c1cf4), [`7df3dbb`](https://github.com/knpkv/npm/commit/7df3dbb9875ab31f369351df2de898b36d40e613), [`8924289`](https://github.com/knpkv/npm/commit/89242895271072b83185d6cc02376b2c56830f6a), [`f8d2612`](https://github.com/knpkv/npm/commit/f8d2612e09b20974dd8eccc8ff197bb072c40cbf), [`38c8af6`](https://github.com/knpkv/npm/commit/38c8af6a0094a1ebb5c6e673c74dc40c5733283f), [`18d5c8b`](https://github.com/knpkv/npm/commit/18d5c8b1bead309094021b0b54fb9d49b83fc50a), [`c037ee6`](https://github.com/knpkv/npm/commit/c037ee6bffca3178d82c5d29a3f203de26db146e), [`b0b385c`](https://github.com/knpkv/npm/commit/b0b385cbfa570e19dd4fa81cd553d3aaf957361f), [`8d051cb`](https://github.com/knpkv/npm/commit/8d051cb05a9b22d59d348346e1f45897fec187b3), [`bf3eb59`](https://github.com/knpkv/npm/commit/bf3eb599a06c5e6c2e7228ce4aaebd9d27f50ee9), [`aac9574`](https://github.com/knpkv/npm/commit/aac9574b6614cdf1f2be74d641c9a191b7e8c903)]:
  - @knpkv/herdr-connect@0.4.5
  - @knpkv/rly@0.9.0
  - @knpkv/herdr-fleet@0.6.0
  - @knpkv/herdr-work@0.6.0
  - @knpkv/herdr-coordinator@0.3.2

## 0.5.4

### Patch Changes

- Updated dependencies [[`487f2ba`](https://github.com/knpkv/npm/commit/487f2ba4fdb585f0cd0b2ab96fd4eeedce9da10d), [`8363bd4`](https://github.com/knpkv/npm/commit/8363bd4dd5fc6df3b15ae70132c080bd52d19a0f)]:
  - @knpkv/rly@0.8.0
  - @knpkv/herdr-work@0.5.3
  - @knpkv/herdr-connect@0.4.4

## 0.5.3

### Patch Changes

- Updated dependencies [[`d5ee299`](https://github.com/knpkv/npm/commit/d5ee299ce3fa5584f2f54051009828af4a26fe4b)]:
  - @knpkv/rly@0.7.0
  - @knpkv/herdr-connect@0.4.3
  - @knpkv/herdr-work@0.5.2

## 0.5.2

### Patch Changes

- [#469](https://github.com/knpkv/npm/pull/469) [`0fd9544`](https://github.com/knpkv/npm/commit/0fd95449194e83de61109d432224acc043f57964) Thanks [@konopkov](https://github.com/konopkov)! - New `@knpkv/bounded-io` package: `limitBytes`, `collectBounded` and `collectBoundedText` read a stream under a byte budget and fail with `ByteLimitExceeded` on the chunk that crosses it. The AI CLI runners and the Herdr command, terminal, Tailscale and HTTP-body readers now use it instead of their own copies; their errors and limits are unchanged, and collection is linear instead of quadratic in the number of chunks.
- Updated dependencies [[`0fd9544`](https://github.com/knpkv/npm/commit/0fd95449194e83de61109d432224acc043f57964)]:
  - @knpkv/bounded-io@0.2.0
  - @knpkv/herdr-connect@0.4.2
  - @knpkv/herdr-fleet@0.5.1
  - @knpkv/herdr-tailscale@0.3.1

## 0.5.1

### Patch Changes

- [#463](https://github.com/knpkv/npm/pull/463) [`2df424b`](https://github.com/knpkv/npm/commit/2df424b8e9c2b33dbb59a34954d84b2ff8903b1e) Thanks [@konopkov](https://github.com/konopkov)! - Every `node:sqlite` Herdr store now opens its database through the new `@knpkv/herdr-fleet/sqlite` opener. An existing group/other-writable state directory or database is now refused at startup and left unchanged; previously the approval store quietly restricted it before Work could refuse it, and `jobs.sqlite` was never checked. `WorkStore.open` now restricts an existing state directory to `0700`, as the other stores already did. The coordinator's orchestrator database reuses the shared path checks with no behaviour change.
- Updated dependencies [[`2df424b`](https://github.com/knpkv/npm/commit/2df424b8e9c2b33dbb59a34954d84b2ff8903b1e)]:
  - @knpkv/herdr-fleet@0.5.0
  - @knpkv/herdr-work@0.5.1
  - @knpkv/herdr-connect@0.4.1
  - @knpkv/herdr-coordinator@0.3.1

## 0.5.0

### Minor Changes

- [#416](https://github.com/knpkv/npm/pull/416) [`c85331a`](https://github.com/knpkv/npm/commit/c85331a01e77941fc0ac3fd952ddf2e471e38277) Thanks [@konopkov](https://github.com/konopkov)! - Link connected Herdr agents to their associated Work goals.

- [#417](https://github.com/knpkv/npm/pull/417) [`d436f2a`](https://github.com/knpkv/npm/commit/d436f2a58430254a8f37b271b25de1830ea15e5b) Thanks [@konopkov](https://github.com/konopkov)! - Add live durable orchestration events, exact-head PR evidence, executable route lookup, atomic Sol-to-Work lineage binding, and an atomic replay-safe worker-start binding that persists the worker identity and Connect target under lane revision authority. Keep completed goals out of Connect association and keep a LAN Work pairing code usable when session-token issuance fails before its atomic consume.

- [#446](https://github.com/knpkv/npm/pull/446) [`9f0be07`](https://github.com/knpkv/npm/commit/9f0be0719005ffd72466345bb8db27a98197451e) Thanks [@konopkov](https://github.com/konopkov)! - Recover an existing unlinked canonical Work goal through a read-only recovery context and preflight, then an approved, history-guarded recovery that links it to an exact worker without rewriting its original checkpoint. Accept the exact legacy worktree repository representation, add prospective PR admission preflight, and expose the recovery and admission routes through fleetctl and the approvals HTTP API. Add typed work.admit, work.recover and work.reconcile Fleet operations, which a host accepts at submission only when its composed Work adapter declares them in `HostOperations.workJobKinds`, and bot-review and formal-review evidence in pull-request evidence.

- [#406](https://github.com/knpkv/npm/pull/406) [`7602437`](https://github.com/knpkv/npm/commit/760243717e7d09adb74816d521a85b89c08a5dc5) Thanks [@konopkov](https://github.com/konopkov)! - Show a redacted, expandable approval request in pending and decision history views.

- [#419](https://github.com/knpkv/npm/pull/419) [`7b8fddb`](https://github.com/knpkv/npm/commit/7b8fddbabe360b01b2f09d1cc223f04463053949) Thanks [@konopkov](https://github.com/konopkov)! - Expose a scoped hostd operations composer for durable coordinator injection, including crash-safe receipt recovery, bounded terminal summaries, and accepted job identity.

- [#424](https://github.com/knpkv/npm/pull/424) [`fa695f0`](https://github.com/knpkv/npm/commit/fa695f0179c67701e468fcedcd07c4b738c9734a) Thanks [@konopkov](https://github.com/konopkov)! - Keep Fleet tabs in one compact iPhone row, preserve terminal pointer access, and distinguish Work loading and failure states.

- [#451](https://github.com/knpkv/npm/pull/451) [`9895206`](https://github.com/knpkv/npm/commit/9895206c410f78370a5bd939a33a5fbb9d0b4b65) Thanks [@konopkov](https://github.com/konopkov)! - Queue `nix.*` and `agent.*` jobs submitted through the verified local hostd listener without approval; Work authority jobs and remote submissions still require approval.

- [#420](https://github.com/knpkv/npm/pull/420) [`3af6bb0`](https://github.com/knpkv/npm/commit/3af6bb0f49806fa651d27aa33db0377fd82f46bb) Thanks [@konopkov](https://github.com/konopkov)! - Harden every durable execution read against command, route, activity-key, linked-parent, orphan-replica, and running-worker binding mismatches before restoring Work authority.

  Add exact-worker recovery replay, queued delivery failure, accepted Work revision and bounded context handoffs, a required `transition_summary` delegate mode, and a typed failed-Luna Sol escalation reference for durable hostd adapters. Preserve valid subset lineages during v1 migration, reject duplicate dispatch replicas and unsupported or malformed persisted handoff versions, validate the complete persisted worker binding, its immutable lane/checkpoint companions, matching handoff goal, exact routed-metadata discriminator, linked terminally failed Luna parent, complete coordinator lifecycle, and a lane head at least as new as the activated binding before restoring revision authority, and validate current v2 dispatch and metadata replicas against the same handoff before readback. Current lane readback also preserves the binding goal, requires an exact immutable operation-ledger replica, and requires the complete claim to remain exact at the binding revision. Reject partial coordinator schemas before either v1 or v2 handoff readback, keep SQL Work DDL inside the fail-closed migration transaction, scope legacy companion reads to the migrated dispatch closure, require every routed Sol dispatch to retain a Work link, validate every modern metadata row against its exact dispatch command, activity key, route discriminator, and Work-link form, reject routed metadata without its dispatch, and require every modern routed dispatch to retain exactly one metadata row. Reject malformed or non-null Luna Work links without charging valid Luna-only history to the Work ledger bound, enforce migrated decision capacity after every legacy upgrade path, and expose stale Sol acceptance as `OrchestratorWorkRevisionConflictError` without a partial dispatch. Routed submissions and durable readback bind `consult` to Luna medium, `transition_summary` to Luna low, and `review` or `work` to Sol high, rejecting persisted command/route mismatches before restoring Work authority. Sol escalation accepts only explicit channel-free `review` and `work` agent-delegate commands. Fleet requires exact persisted-worker replay before recovery can report a terminal result and accepts relationship-free coordinator roots only for consultation and transition summaries.

- [#447](https://github.com/knpkv/npm/pull/447) [`742e9b5`](https://github.com/knpkv/npm/commit/742e9b51e9b7d7d32639744cfd433de164135069) Thanks [@konopkov](https://github.com/konopkov)! - Add the approval-gated `work.reassign` Fleet operation. It moves one Work goal, and its active lane, from the exact current owner to a new owner in one transaction guarded by the goal's expected head event. The request names the agent outcome explicitly: `set` moves the goal's agent target and rebinds a bound lane to the new worker, `clear` removes the target, and `keep` is accepted only when the goal has none. `set` is refused, with nothing written, when the agent is already the current target of another goal or the authoritative binding of another goal's lane. A shipped lane keeps its previous owner, and admission preflight treats each lane's latest binding as its authority, so a rebound lane still reads as existing for its new worker. The new checkpoint records who approved it, the activity summary is bounded before approval, and replaying the same approval job is idempotent. Approvals render every hash-bound field of the request, fleetctl can submit it, and `runWorkReassign` executes it from a composed host that declares `work.reassign` in `HostOperations.workJobKinds`. A host without that adapter refuses the job at submission. `canonicalJobPayload` exports the exact text bound into a job's approval hash. Every Work approval request now displays each of its hash-bound fields, including worker names and admission worker lineage.

  Follow-up, not covered here: lane claims and checkpoint appends can still change an owner without an approved reassignment.

### Patch Changes

- [#421](https://github.com/knpkv/npm/pull/421) [`ffeaaf2`](https://github.com/knpkv/npm/commit/ffeaaf23ed4e7bb31d4ac0805b394173d67284c1) Thanks [@konopkov](https://github.com/konopkov)! - Keep Fleet application tabs clickable while an embedded Connect terminal is active and focused.

- [#452](https://github.com/knpkv/npm/pull/452) [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade to Effect 4.0.0 stable. `effect` and every `@effect/*` dependency or peer dependency now require `4.0.0`; imports move from the removed `effect/unstable/*` paths to `effect/*`.
- Updated dependencies [[`c2da700`](https://github.com/knpkv/npm/commit/c2da70083bc4f8e82f9c6bd3dc2541e131585a5c), [`adfad78`](https://github.com/knpkv/npm/commit/adfad78662f20b698a2c6d76a70e824c52e22029), [`17df0ad`](https://github.com/knpkv/npm/commit/17df0ad67dcf339d0d9541656be1ce236c3e34a2), [`c85331a`](https://github.com/knpkv/npm/commit/c85331a01e77941fc0ac3fd952ddf2e471e38277), [`d436f2a`](https://github.com/knpkv/npm/commit/d436f2a58430254a8f37b271b25de1830ea15e5b), [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e), [`9f0be07`](https://github.com/knpkv/npm/commit/9f0be0719005ffd72466345bb8db27a98197451e), [`b2d229d`](https://github.com/knpkv/npm/commit/b2d229d2208fb9e7f2d9dc174ff12d769c5b8225), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`8022091`](https://github.com/knpkv/npm/commit/802209142207593461eaef384d31757f746a2452), [`7b8fddb`](https://github.com/knpkv/npm/commit/7b8fddbabe360b01b2f09d1cc223f04463053949), [`fa695f0`](https://github.com/knpkv/npm/commit/fa695f0179c67701e468fcedcd07c4b738c9734a), [`2f51fbb`](https://github.com/knpkv/npm/commit/2f51fbb893a6440ecd5cabf6b73bb52131395bc3), [`9895206`](https://github.com/knpkv/npm/commit/9895206c410f78370a5bd939a33a5fbb9d0b4b65), [`3af6bb0`](https://github.com/knpkv/npm/commit/3af6bb0f49806fa651d27aa33db0377fd82f46bb), [`de01905`](https://github.com/knpkv/npm/commit/de0190543c6b030f8616f68d78192cb65cc98899), [`a7db83b`](https://github.com/knpkv/npm/commit/a7db83b401fbe08a6a05d2500ec020cd6d03c8e6), [`2cb8964`](https://github.com/knpkv/npm/commit/2cb8964f9427e938c9aa75a3d401908884482d38), [`6ce5d6a`](https://github.com/knpkv/npm/commit/6ce5d6a1919515b9701ba0f0ec78c01cb408b623), [`fecd5b0`](https://github.com/knpkv/npm/commit/fecd5b05e26df62f87ea0f66f226cefdb685cc59), [`bd51a53`](https://github.com/knpkv/npm/commit/bd51a5316452fd24dd6352399bf11a764c3ca401), [`742e9b5`](https://github.com/knpkv/npm/commit/742e9b51e9b7d7d32639744cfd433de164135069)]:
  - @knpkv/herdr-work@0.5.0
  - @knpkv/rly@0.6.0
  - @knpkv/herdr-connect@0.4.0
  - @knpkv/herdr-coordinator@0.3.0
  - @knpkv/herdr-fleet@0.4.0
  - @knpkv/herdr-tailscale@0.3.0

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
