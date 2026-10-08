# @knpkv/herdr-work

## 0.9.3

### Patch Changes

- Updated dependencies [[`69b015c`](https://github.com/knpkv/npm/commit/69b015cb21c15723688acff8a22515fdc4cd09d6), [`67f7ea1`](https://github.com/knpkv/npm/commit/67f7ea1a5e3c0281da1d627fce940975e2db0cf4), [`f5f5fd9`](https://github.com/knpkv/npm/commit/f5f5fd98dcea7b7df1b226043e89ffb6decaffad), [`ce3234a`](https://github.com/knpkv/npm/commit/ce3234a201e3336b17f22219c8215d11eecc3408), [`4a41bf8`](https://github.com/knpkv/npm/commit/4a41bf82e327ec66a5df1202920f08e8e51554a4), [`e584518`](https://github.com/knpkv/npm/commit/e584518c9c98186e331a9962c4c6347c470cb3c5), [`d476bb0`](https://github.com/knpkv/npm/commit/d476bb0b2e2399c72eb2cd7b8c6005d833464598), [`4ed3921`](https://github.com/knpkv/npm/commit/4ed39215d9d61071d6ce040b5a5cac77db963327), [`765e850`](https://github.com/knpkv/npm/commit/765e850895d4edc16a75b3af072f71d527ad0b8c)]:
  - @knpkv/rly@0.16.0

## 0.9.2

### Patch Changes

- Updated dependencies [[`dfa2d94`](https://github.com/knpkv/npm/commit/dfa2d94ea207baeb281ef222c7d28cf98e4962bb), [`5d21796`](https://github.com/knpkv/npm/commit/5d21796fb856fba44a32395e316a6bd95ecdbdd6), [`aa41111`](https://github.com/knpkv/npm/commit/aa411113b76d81637f7af356bf04054246aa30ab), [`3ddf05b`](https://github.com/knpkv/npm/commit/3ddf05baa285beebba1ebe99bd2458434a613015)]:
  - @knpkv/rly@0.15.0

## 0.9.1

### Patch Changes

- Updated dependencies [[`da04e85`](https://github.com/knpkv/npm/commit/da04e85df105627acbfcc017ee0f15e6f4d6f20d), [`dd7a33a`](https://github.com/knpkv/npm/commit/dd7a33a7377370f381ba67d4eb4f9e2bb4961597), [`ae23e4d`](https://github.com/knpkv/npm/commit/ae23e4d56302af2916e5655e27736bb954e525ae), [`c15ee76`](https://github.com/knpkv/npm/commit/c15ee763636ef1d8f006ddd31c71df771748f9db)]:
  - @knpkv/herdr-fleet@0.8.0
  - @knpkv/rly@0.14.0

## 0.9.0

### Minor Changes

- [#591](https://github.com/knpkv/npm/pull/591) [`0d6cc4d`](https://github.com/knpkv/npm/commit/0d6cc4df23eca64c5d29725bf50899776cc52435) Thanks [@konopkov](https://github.com/konopkov)! - `WorkService.planReconcile({ confirmed })` answers what `reconcile` would do now, writing nothing. It shares `reconcile`'s planning: capacity, confirmation, failure and already-stamped checks, and each checkpoint's validation, each check in its own transaction rolled back at once, with later steps checked against the checkpoints earlier ones planned. A plan is advisory; `reconcile` decides again from the store as it then is. Steps are `would_apply` (with the fact behind it and the goal's latest event id and `updatedAt` it was planned from), `recorded` or `conflict`. A shadow run in observe mode measures the real decisions this way.

### Patch Changes

- Updated dependencies [[`26bc385`](https://github.com/knpkv/npm/commit/26bc385b4fafdffaf246cbdfa06995b3ecf66047)]:
  - @knpkv/rly@0.13.0

## 0.8.1

### Patch Changes

- [#590](https://github.com/knpkv/npm/pull/590) [`69eb086`](https://github.com/knpkv/npm/commit/69eb08644a3b9e39ba97fd0205a985e5e7208a26) Thanks [@konopkov](https://github.com/konopkov)! - Work activity for an approved reassignment or abandonment reads as a sentence: "Reassigned from host-coordinator to claude-coordinator: <reason>" and "Abandoned: <reason>". Owner ids and the approval's job id and hash no longer appear in the text; they stay structured on the reassignment and abandonment records. `workReassignActivitySummary` and `workAbandonActivitySummary` now take only the payload. Events already recorded keep their earlier text.

- [#600](https://github.com/knpkv/npm/pull/600) [`bfba87c`](https://github.com/knpkv/npm/commit/bfba87c566ca21d267c0626da60b431757dc5e32) Thanks [@konopkov](https://github.com/konopkov)! - A decided request drops its Approve/Reject bar once the snapshot proves the outcome: it reads as its title and state word, a refusal keeps its explanation, and the outcome is announced. While a bar is shown, the request is named once, by the bar.
- Updated dependencies [[`69eb086`](https://github.com/knpkv/npm/commit/69eb08644a3b9e39ba97fd0205a985e5e7208a26)]:
  - @knpkv/herdr-fleet@0.7.0

## 0.8.0

### Minor Changes

- [#527](https://github.com/knpkv/npm/pull/527) [`f8e842e`](https://github.com/knpkv/npm/commit/f8e842e901986b50edf55f98fa3591b742a7904e) Thanks [@konopkov](https://github.com/konopkov)! - `WorkBoard` takes an optional `decisions` prop so a host that can decide approvals lets the reader approve or reject a goal's request in place, with its clock ("4m 12s left") on the request and its row. Requests the host cannot decide keep their link to the hub, the bar stays mounted after a decision so the hub's answer is announced, and the read-only view never offers a decision.

- [#528](https://github.com/knpkv/npm/pull/528) [`30849c5`](https://github.com/knpkv/npm/commit/30849c598fdf6776a3a4a2c4061d276e843eaa8e) Thanks [@konopkov](https://github.com/konopkov)! - The Work tab shows what the reconciler observed. Goals group, filter and show their state by the observed overlay where there is one (a merged pull request is done, a closed one abandoned), and the detail names the recorded state when they differ. The open goal lists its observed pull request, flags an owner whose agent has been gone for a day, and says when a source could not be read and how old its facts are; observed events join the activity timeline with their provenance, an unreadable source drawn hatched. The header says when live state is unavailable or trimmed. Planned goals get their own "Not started" group instead of counting as moving, rows name the repository instead of its full path, facts stack on narrow screens, and the empty board says how to delegate the first goal.

### Patch Changes

- Updated dependencies [[`c22e8ae`](https://github.com/knpkv/npm/commit/c22e8ae0c55a50e9c1edbd46a1cd18108f62e4fa)]:
  - @knpkv/rly@0.12.1

## 0.7.2

### Patch Changes

- [#575](https://github.com/knpkv/npm/pull/575) [`655f010`](https://github.com/knpkv/npm/commit/655f010c2bb14b4118d81c60025ac64006b73f1c) Thanks [@konopkov](https://github.com/konopkov)! - Focus rings match rly's: a solid 2px outline in the focus colour, 2px outside the control, from `--rly-focus-ring-width` and `--rly-focus-ring-offset`. Hand-rolled 1px to 3px rings, rings in agent, service or text colours, tinted halos and box-shadow rings are gone. Rings inside clipped containers pull the ring width inside.
- Updated dependencies [[`4965043`](https://github.com/knpkv/npm/commit/4965043541a324f630b847ed4d852b6722f6efe6)]:
  - @knpkv/rly@0.12.0

## 0.7.1

### Patch Changes

- Updated dependencies [[`6d215b2`](https://github.com/knpkv/npm/commit/6d215b2fa9bb3e98f447efbbddcb299c41a4efc5)]:
  - @knpkv/rly@0.11.0

## 0.7.0

### Minor Changes

- [#539](https://github.com/knpkv/npm/pull/539) [`d266e4c`](https://github.com/knpkv/npm/commit/d266e4cccb601e0d8006ce50e48743b8f347f21e) Thanks [@konopkov](https://github.com/konopkov)! - `WorkService.reconcile` now takes `{ confirmed }`: the `subject` and `observationId` of each fact the caller has just read and the store accepted. `observe` reports the `observationId` (the stored fact's SHA-256 id) on its `stored` and `unchanged` outcomes. A goal is closed only from a pull request fact on that list. A read refused as stale, or one that failed, confirms nothing, so an earlier fact (the pull request may since have reopened) is never acted on, including for superseded goals, which the snapshot hides, and whatever failure records were evicted. A confirmation that is no longer the subject's stored fact fails with `WorkStoreError` (`reconcile.confirmed`), and a malformed one with `reconcile.options`. A failed read newer than a fact's confirmation is also checked, inside the write's transaction too. Callers of the former argument-less `reconcile()` pass the ids from their `observe` report. An identical read older than the stored confirmation is reported `stale`, Evicting a failed read that disputes a fact evicts that fact too, and the store keeps the newest time of anything it has evicted: a fact read no newer than that, for a subject with no stored row, is reported `stale`, so neither an old confirmation nor a replay of it can close a goal. `observe` reports its outcomes after every write and eviction in the call, so a `stored` or `unchanged` fact replaced later in the same batch, or evicted, is reported `stale`. `WorkObservationId` is now a branded type: the lowercase-hex SHA-256 of the fact's stored record (the encoded observation's JSON with its repository or host ASCII-lowercased, `observedAt` excluded). On upgrade, a store that predates the eviction watermark drops its observed facts and failures (a cache of provider reads) and sets the watermark to the newest of them, so none of its older reads can confirm anything; the next pass reads them again.

### Patch Changes

- Updated dependencies [[`b791563`](https://github.com/knpkv/npm/commit/b791563a328c0118c2716bda59294f7c606225c8), [`c93baf2`](https://github.com/knpkv/npm/commit/c93baf29bba9d67ffc4938ce0b0ada533260fddc)]:
  - @knpkv/herdr-fleet@0.6.1
  - @knpkv/rly@0.10.0

## 0.6.0

### Minor Changes

- [#523](https://github.com/knpkv/npm/pull/523) [`38c8af6`](https://github.com/knpkv/npm/commit/38c8af6a0094a1ebb5c6e673c74dc40c5733283f) Thanks [@konopkov](https://github.com/konopkov)! - New approval-bound `work.abandon` job, which moves one Work goal to `abandoned`. The payload names the goal, its exact owner, a reason and the goal's expected head. The job hash covers every field, and the job always needs approval. `WorkService.abandon` clears the blocker and records a status activity naming the approved job. It refuses a goal with an active lane (`WorkGoalLaneActiveError`, naming the lane), a goal that has already finished (`WorkGoalTerminalError`), a stale head and a different owner. An exact replay returns the stored result. `runWorkAbandon` executes the job only with a persisted approval. The hub shows its fields, history and dashboard label, and `fleetctl submit HOST work.abandon PAYLOAD_JSON` submits it.

- [#520](https://github.com/knpkv/npm/pull/520) [`c037ee6`](https://github.com/knpkv/npm/commit/c037ee6bffca3178d82c5d29a3f203de26db146e) Thanks [@konopkov](https://github.com/konopkov)! - `admitObserved` admits a worker the reconciler observed, without an approval: the same write as `admitExistingOwner`, checked against the same absence token, with `observedAdmission` provenance on the binding (actor `reconciler` and the observation id) in place of an approval. Its admission activity is credited to the reconciler, and the goal can still be closed by the reconciler when its pull request merges or closes.

- [#514](https://github.com/knpkv/npm/pull/514) [`b0b385c`](https://github.com/knpkv/npm/commit/b0b385cbfa570e19dd4fa81cd553d3aaf957361f) Thanks [@konopkov](https://github.com/konopkov)! - Add observed facts for the Work tab. `WorkService.observe` stores the latest fact per pull request or agent in a bounded overlay that is never goal history and never part of an approval token, and `snapshots` merges those facts into the `now` window as `observed` entries with first-seen and last-confirmed times, the goal's current read failure (`unknown`), a derived `displayState` and a 24-hour `stale` flag. `WorkStoreService` gains the required `observe` method.

- [#513](https://github.com/knpkv/npm/pull/513) [`8d051cb`](https://github.com/knpkv/npm/commit/8d051cb05a9b22d59d348346e1f45897fec187b3) Thanks [@konopkov](https://github.com/konopkov)! - The Work tab leads with what needs you. A one-line summary ("3 goals need you, 2 blocked") is followed by the goals grouped as Needs you, Blocked, Moving, Done in the last 24 hours and Finished earlier. The open goal shows its delivery stages as words, its facts, blockers, requests (with the hub approval link) and its activity as a timeline. Snapshot windows, status filters, deep links and paging work as before.

- [#516](https://github.com/knpkv/npm/pull/516) [`bf3eb59`](https://github.com/knpkv/npm/commit/bf3eb599a06c5e6c2e7228ce4aaebd9d27f50ee9) Thanks [@konopkov](https://github.com/konopkov)! - Add the `abandoned` Work state and `WorkService.reconcile`. `reconcile` records each goal whose pull request is observed merged or closed as `completed` (delivery `merged`) or `abandoned`, stamped with the pull request's own close time (one millisecond after the goal's latest checkpoint when an owner wrote later). It writes only when that latest checkpoint is still the one it planned from, never stamps a goal twice, and always leaves 256 checkpoints of history free. `isTerminalWorkState` names the finished states; every check that treated `completed` as finished now treats `abandoned` the same way. Snapshots' `now` window now says who wrote each non-owner activity (`activityProvenance`, `activityProvenanceGoals`, `activityProvenanceOmitted`), trimmed by whole goals to the response budget.

### Patch Changes

- [#506](https://github.com/knpkv/npm/pull/506) [`18d5c8b`](https://github.com/knpkv/npm/commit/18d5c8b1bead309094021b0b54fb9d49b83fc50a) Thanks [@konopkov](https://github.com/konopkov)! - Migrating a pre-session Work file no longer leaves it unopenable. In a legacy file whose lane claims predate goal and operation ids, a claim that a running agent binding recorded at the same revision now takes that binding's lane instead of the lane id; before, the first open migrated the file, and every later open rejected the binding. A claim that moved past its bindings keeps the lane-id operation and takes its lane's goal. A file an earlier version already migrated into that state is still rejected at open, unchanged; repairing it is separate work. WorkStore also records each migrated claim's lane operation when the operation ledger already exists. In both drivers, an existing ledger row with that operation id must be the same claim (`lane-operation-collision` otherwise), and the new rows must fit the ledger's bounds (`lane-operation-capacity` otherwise). A claim held by two bindings at one revision fails with `lane-binding-ambiguous`; a bound lane that disagrees with a field the claim recorded fails with `lane-binding-mismatch`. Every one of these failures leaves the file unchanged.

- [#518](https://github.com/knpkv/npm/pull/518) [`aac9574`](https://github.com/knpkv/npm/commit/aac9574b6614cdf1f2be74d641c9a191b7e8c903) Thanks [@konopkov](https://github.com/konopkov)! - `WorkStore.open` now enforces one coordinator handoff per session on files migrated from v1 handoffs. Those files gained `session_id` through `ALTER TABLE`, which cannot add a column UNIQUE constraint, and kept a plain session index; the SQL bridge's unique index never replaced it because `WorkStore` opens first. Opening such a file, with WorkStore or the SQL bridge, replaces the plain index with a unique one in one transaction, and fails closed (`open.database`, caused by `open.migrate.session-index`) if two handoffs already share a session, leaving the file unchanged.
- Updated dependencies [[`934843b`](https://github.com/knpkv/npm/commit/934843bbcea57cbf3266fce950c020733046cac1), [`148daa6`](https://github.com/knpkv/npm/commit/148daa6be147dca74bc642bd552b603deb760eae), [`4e8f346`](https://github.com/knpkv/npm/commit/4e8f346b926b859ea2b3be07ec7dc6cb77ca8e76), [`e57bb6d`](https://github.com/knpkv/npm/commit/e57bb6db1b393dbff8e116573cf2db23992c1cf4), [`7df3dbb`](https://github.com/knpkv/npm/commit/7df3dbb9875ab31f369351df2de898b36d40e613), [`8924289`](https://github.com/knpkv/npm/commit/89242895271072b83185d6cc02376b2c56830f6a), [`f8d2612`](https://github.com/knpkv/npm/commit/f8d2612e09b20974dd8eccc8ff197bb072c40cbf), [`38c8af6`](https://github.com/knpkv/npm/commit/38c8af6a0094a1ebb5c6e673c74dc40c5733283f)]:
  - @knpkv/rly@0.9.0
  - @knpkv/herdr-fleet@0.6.0

## 0.5.3

### Patch Changes

- [#490](https://github.com/knpkv/npm/pull/490) [`8363bd4`](https://github.com/knpkv/npm/commit/8363bd4dd5fc6df3b15ae70132c080bd52d19a0f) Thanks [@konopkov](https://github.com/konopkov)! - `WorkStore.open` now upgrades legacy tables and creates or completes Work's schema in one transaction. If any step fails, the file is left exactly as it was, and opening a file no longer syncs it to disk once per schema statement.
- Updated dependencies [[`487f2ba`](https://github.com/knpkv/npm/commit/487f2ba4fdb585f0cd0b2ab96fd4eeedce9da10d)]:
  - @knpkv/rly@0.8.0

## 0.5.2

### Patch Changes

- Updated dependencies [[`d5ee299`](https://github.com/knpkv/npm/commit/d5ee299ce3fa5584f2f54051009828af4a26fe4b)]:
  - @knpkv/rly@0.7.0

## 0.5.1

### Patch Changes

- [#463](https://github.com/knpkv/npm/pull/463) [`2df424b`](https://github.com/knpkv/npm/commit/2df424b8e9c2b33dbb59a34954d84b2ff8903b1e) Thanks [@konopkov](https://github.com/konopkov)! - Every `node:sqlite` Herdr store now opens its database through the new `@knpkv/herdr-fleet/sqlite` opener. An existing group/other-writable state directory or database is now refused at startup and left unchanged; previously the approval store quietly restricted it before Work could refuse it, and `jobs.sqlite` was never checked. `WorkStore.open` now restricts an existing state directory to `0700`, as the other stores already did. The coordinator's orchestrator database reuses the shared path checks with no behaviour change.
- Updated dependencies [[`2df424b`](https://github.com/knpkv/npm/commit/2df424b8e9c2b33dbb59a34954d84b2ff8903b1e)]:
  - @knpkv/herdr-fleet@0.5.0

## 0.5.0

### Minor Changes

- [#422](https://github.com/knpkv/npm/pull/422) [`c2da700`](https://github.com/knpkv/npm/commit/c2da70083bc4f8e82f9c6bd3dc2541e131585a5c) Thanks [@konopkov](https://github.com/konopkov)! - Bound crowded Work boards to ten goals at a time, add status filtering and explicit goal details, and compact iPhone rows.

- [#416](https://github.com/knpkv/npm/pull/416) [`c85331a`](https://github.com/knpkv/npm/commit/c85331a01e77941fc0ac3fd952ddf2e471e38277) Thanks [@konopkov](https://github.com/konopkov)! - Link connected Herdr agents to their associated Work goals.

- [#417](https://github.com/knpkv/npm/pull/417) [`d436f2a`](https://github.com/knpkv/npm/commit/d436f2a58430254a8f37b271b25de1830ea15e5b) Thanks [@konopkov](https://github.com/konopkov)! - Add live durable orchestration events, exact-head PR evidence, executable route lookup, atomic Sol-to-Work lineage binding, and an atomic replay-safe worker-start binding that persists the worker identity and Connect target under lane revision authority. Keep completed goals out of Connect association and keep a LAN Work pairing code usable when session-token issuance fails before its atomic consume.

- [#452](https://github.com/knpkv/npm/pull/452) [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade to Effect 4.0.0 stable. `effect` and every `@effect/*` dependency or peer dependency now require `4.0.0`; imports move from the removed `effect/unstable/*` paths to `effect/*`.

- [#446](https://github.com/knpkv/npm/pull/446) [`9f0be07`](https://github.com/knpkv/npm/commit/9f0be0719005ffd72466345bb8db27a98197451e) Thanks [@konopkov](https://github.com/konopkov)! - Recover an existing unlinked canonical Work goal through a read-only recovery context and preflight, then an approved, history-guarded recovery that links it to an exact worker without rewriting its original checkpoint. Accept the exact legacy worktree repository representation, add prospective PR admission preflight, and expose the recovery and admission routes through fleetctl and the approvals HTTP API. Add typed work.admit, work.recover and work.reconcile Fleet operations, which a host accepts at submission only when its composed Work adapter declares them in `HostOperations.workJobKinds`, and bot-review and formal-review evidence in pull-request evidence.

- [#420](https://github.com/knpkv/npm/pull/420) [`3af6bb0`](https://github.com/knpkv/npm/commit/3af6bb0f49806fa651d27aa33db0377fd82f46bb) Thanks [@konopkov](https://github.com/konopkov)! - Harden every durable execution read against command, route, activity-key, linked-parent, orphan-replica, and running-worker binding mismatches before restoring Work authority.

  Add exact-worker recovery replay, queued delivery failure, accepted Work revision and bounded context handoffs, a required `transition_summary` delegate mode, and a typed failed-Luna Sol escalation reference for durable hostd adapters. Preserve valid subset lineages during v1 migration, reject duplicate dispatch replicas and unsupported or malformed persisted handoff versions, validate the complete persisted worker binding, its immutable lane/checkpoint companions, matching handoff goal, exact routed-metadata discriminator, linked terminally failed Luna parent, complete coordinator lifecycle, and a lane head at least as new as the activated binding before restoring revision authority, and validate current v2 dispatch and metadata replicas against the same handoff before readback. Current lane readback also preserves the binding goal, requires an exact immutable operation-ledger replica, and requires the complete claim to remain exact at the binding revision. Reject partial coordinator schemas before either v1 or v2 handoff readback, keep SQL Work DDL inside the fail-closed migration transaction, scope legacy companion reads to the migrated dispatch closure, require every routed Sol dispatch to retain a Work link, validate every modern metadata row against its exact dispatch command, activity key, route discriminator, and Work-link form, reject routed metadata without its dispatch, and require every modern routed dispatch to retain exactly one metadata row. Reject malformed or non-null Luna Work links without charging valid Luna-only history to the Work ledger bound, enforce migrated decision capacity after every legacy upgrade path, and expose stale Sol acceptance as `OrchestratorWorkRevisionConflictError` without a partial dispatch. Routed submissions and durable readback bind `consult` to Luna medium, `transition_summary` to Luna low, and `review` or `work` to Sol high, rejecting persisted command/route mismatches before restoring Work authority. Sol escalation accepts only explicit channel-free `review` and `work` agent-delegate commands. Fleet requires exact persisted-worker replay before recovery can report a terminal result and accepts relationship-free coordinator roots only for consultation and transition summaries.

- [#418](https://github.com/knpkv/npm/pull/418) [`bd51a53`](https://github.com/knpkv/npm/commit/bd51a5316452fd24dd6352399bf11a764c3ca401) Thanks [@konopkov](https://github.com/konopkov)! - Consolidate duplicate superseded Work goals into canonical families while preserving historical checkpoints, review states, and blockers and exposing compact history.

- [#447](https://github.com/knpkv/npm/pull/447) [`742e9b5`](https://github.com/knpkv/npm/commit/742e9b51e9b7d7d32639744cfd433de164135069) Thanks [@konopkov](https://github.com/konopkov)! - Add the approval-gated `work.reassign` Fleet operation. It moves one Work goal, and its active lane, from the exact current owner to a new owner in one transaction guarded by the goal's expected head event. The request names the agent outcome explicitly: `set` moves the goal's agent target and rebinds a bound lane to the new worker, `clear` removes the target, and `keep` is accepted only when the goal has none. `set` is refused, with nothing written, when the agent is already the current target of another goal or the authoritative binding of another goal's lane. A shipped lane keeps its previous owner, and admission preflight treats each lane's latest binding as its authority, so a rebound lane still reads as existing for its new worker. The new checkpoint records who approved it, the activity summary is bounded before approval, and replaying the same approval job is idempotent. Approvals render every hash-bound field of the request, fleetctl can submit it, and `runWorkReassign` executes it from a composed host that declares `work.reassign` in `HostOperations.workJobKinds`. A host without that adapter refuses the job at submission. `canonicalJobPayload` exports the exact text bound into a job's approval hash. Every Work approval request now displays each of its hash-bound fields, including worker names and admission worker lineage.

  Follow-up, not covered here: lane claims and checkpoint appends can still change an owner without an approved reassignment.

### Patch Changes

- [#426](https://github.com/knpkv/npm/pull/426) [`2cb8964`](https://github.com/knpkv/npm/commit/2cb8964f9427e938c9aa75a3d401908884482d38) Thanks [@konopkov](https://github.com/konopkov)! - Remove idle underlines from Work snapshot and board navigation links while keeping hover and keyboard focus cues.
- Updated dependencies [[`adfad78`](https://github.com/knpkv/npm/commit/adfad78662f20b698a2c6d76a70e824c52e22029), [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e), [`9f0be07`](https://github.com/knpkv/npm/commit/9f0be0719005ffd72466345bb8db27a98197451e), [`b2d229d`](https://github.com/knpkv/npm/commit/b2d229d2208fb9e7f2d9dc174ff12d769c5b8225), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`8022091`](https://github.com/knpkv/npm/commit/802209142207593461eaef384d31757f746a2452), [`7b8fddb`](https://github.com/knpkv/npm/commit/7b8fddbabe360b01b2f09d1cc223f04463053949), [`fa695f0`](https://github.com/knpkv/npm/commit/fa695f0179c67701e468fcedcd07c4b738c9734a), [`9895206`](https://github.com/knpkv/npm/commit/9895206c410f78370a5bd939a33a5fbb9d0b4b65), [`3af6bb0`](https://github.com/knpkv/npm/commit/3af6bb0f49806fa651d27aa33db0377fd82f46bb), [`6ce5d6a`](https://github.com/knpkv/npm/commit/6ce5d6a1919515b9701ba0f0ec78c01cb408b623), [`fecd5b0`](https://github.com/knpkv/npm/commit/fecd5b05e26df62f87ea0f66f226cefdb685cc59), [`742e9b5`](https://github.com/knpkv/npm/commit/742e9b51e9b7d7d32639744cfd433de164135069)]:
  - @knpkv/rly@0.6.0
  - @knpkv/herdr-fleet@0.4.0

## 0.4.0

### Minor Changes

- [#414](https://github.com/knpkv/npm/pull/414) [`1800d52`](https://github.com/knpkv/npm/commit/1800d528024607ef63dbfd0cd8a92a8b8622f783) Thanks [@konopkov](https://github.com/konopkov)! - Add typed canonical and superseded goal-family relations while preserving superseded checkpoints in historical Work snapshots.

- [#404](https://github.com/knpkv/npm/pull/404) [`beed20b`](https://github.com/knpkv/npm/commit/beed20b1255616223d74e244065b560c7407eec2) Thanks [@konopkov](https://github.com/konopkov)! - Add an opt-in read-only LAN Work listener with five-minute browser pairing.

### Patch Changes

- [#407](https://github.com/knpkv/npm/pull/407) [`cf83d20`](https://github.com/knpkv/npm/commit/cf83d20883d8eca0bc1fcddeb0632a94c947a238) Thanks [@konopkov](https://github.com/konopkov)! - Harden the typed Work record and snapshot bridge with structural replay idempotency and fail-closed response decoding.
- Updated dependencies [[`beed20b`](https://github.com/knpkv/npm/commit/beed20b1255616223d74e244065b560c7407eec2), [`43f1174`](https://github.com/knpkv/npm/commit/43f1174633ebba9d6244156fffa23514c89b4c74), [`1dcc473`](https://github.com/knpkv/npm/commit/1dcc473ebd14c2a4ac00d7fd67bf9a8d80201f66), [`be9feff`](https://github.com/knpkv/npm/commit/be9feff762ab43b39c887b39815a2959714d7364)]:
  - @knpkv/herdr-fleet@0.3.0
  - @knpkv/rly@0.5.1

## 0.3.0

### Minor Changes

- [#392](https://github.com/knpkv/npm/pull/392) [`da8c8c0`](https://github.com/knpkv/npm/commit/da8c8c08b144a2ea8dfd837ecfa433cae1ad13a7) Thanks [@konopkov](https://github.com/konopkov)! - Add the typed daily fleet Work control view with authoritative agent hierarchy, activity, requests, review state, shipment stages, and exact Connect and approval links.

### Patch Changes

- Updated dependencies [[`75ece0a`](https://github.com/knpkv/npm/commit/75ece0ab3d666488bc32820aeef56adb0873cead)]:
  - @knpkv/rly@0.5.0

## 0.2.0

### Minor Changes

- [#384](https://github.com/knpkv/npm/pull/384) [`ac866e9`](https://github.com/knpkv/npm/commit/ac866e98e1b69f22f63618f9189482a34171edd0) Thanks [@konopkov](https://github.com/konopkov)! - Publish the Herdr fleet protocol, Tailscale adapter, Connect terminal, coordinator chat, durable Work board, and shared approval host runtime as reusable packages.

- [#388](https://github.com/knpkv/npm/pull/388) [`182cdbc`](https://github.com/knpkv/npm/commit/182cdbcaa20824c95763b9ddc0695f1ec6ae5ace) Thanks [@konopkov](https://github.com/konopkov)! - Make Work checkpoint recording loopback-only, idempotent for exact replays, and available through `fleetctl work snapshot`.

### Patch Changes

- Updated dependencies [[`ac866e9`](https://github.com/knpkv/npm/commit/ac866e98e1b69f22f63618f9189482a34171edd0), [`94ee004`](https://github.com/knpkv/npm/commit/94ee00487f0595cdc16fd8f1332689eb39ecfaf2)]:
  - @knpkv/herdr-fleet@0.2.0
  - @knpkv/rly@0.4.1
