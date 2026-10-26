# @knpkv/herdr-fleet

## 0.24.0

### Minor Changes

- [#1146](https://github.com/knpkv/npm/pull/1146) [`f6b820d`](https://github.com/knpkv/npm/commit/f6b820d78609a228a61021e587def9476c9bf77b) Thanks [@konopkov](https://github.com/konopkov)! - Put the hub behind login.

  - herdr-fleet `can()`: a person or the local user without a browser session holds nothing; the CLI token holds `view`, `jobs.submit` and `apps.restart`.
  - herdr-hub: the tailnet hub and loopback listeners decide every request by who the caller is. A browser without a session gets the page 22 login gate and `401 login_required`, a browser on a fleet host included; agents and hosts keep their own credentials (the CLI token on loopback, the host's node on the tailnet); a session's writes need its CSRF token, which the super-app's browser clients now send with every write to the hub; an app's writes need the hub's own `Origin` instead, and are refused without one; a route no family names gets 404; the browser terminal passes the same gate. The CLI token may try again any failed job from Needs you.
  - The loopback session moves to an HttpOnly `herdr_local_session` cookie; the page keeps no token of its own.
  - `GET /v1/session` says whether a session ended and whether the caller is on a fleet machine. Session cookies last 8 days, past every session's end, so an ended session is reported as ended.
  - `fleetctl` and `herdr-hub apps` send the CLI token on loopback.

## 0.23.0

### Minor Changes

- [#1142](https://github.com/knpkv/npm/pull/1142) [`38c3bc2`](https://github.com/knpkv/npm/commit/38c3bc2e4c91bc411bab592f73066ddf142b9e86) Thanks [@konopkov](https://github.com/konopkov)! - New `@knpkv/herdr-fleet/job-outcome` export. `jobOutcome(record)` says what became of a job: pending, running, succeeded, rejected, expired, failed, or failed after a person approved it. `jobFailureReason(error)` sorts a failure into a closed set of reasons with one plain line each ("The agent didn't report back in time", "The hub restarted while it ran", "The checkout wasn't on main", …). A structured agent error is matched by its code before any text.

## 0.22.0

### Minor Changes

- [#1132](https://github.com/knpkv/npm/pull/1132) [`9bad0f1`](https://github.com/knpkv/npm/commit/9bad0f1312266acc6f166d91a8b756199f7610ad) Thanks [@konopkov](https://github.com/konopkov)! - `Person` principals carry `session`. Without a browser session a person only views. A person logged in on a fleet machine never holds `sandboxes.owner`. A new `Cli` principal, a command holding the hub's CLI token, holds only `apps.restart`.

## 0.21.1

### Patch Changes

- [#1129](https://github.com/knpkv/npm/pull/1129) [`0b2d854`](https://github.com/knpkv/npm/commit/0b2d854e4417e4377908e6df39333763728556ff) Thanks [@konopkov](https://github.com/konopkov)! - Refuse a fleet configuration that lists one node both as a fleet machine and in `approvalNodes`. Fleet machines run agents under the owner's login, so a machine never approves.

## 0.21.0

### Minor Changes

- [#1120](https://github.com/knpkv/npm/pull/1120) [`36501ee`](https://github.com/knpkv/npm/commit/36501ee2b18aaf1cdd2d45789b649ce15881287c) Thanks [@konopkov](https://github.com/konopkov)! - Add hub permissions: a closed `Permission` list, the optional `users`, `hosts` and `local` configuration keys, and `can(config, principal, permission)` for `Person`, `Host`, `Local`, `Service` and `Anonymous` callers. A permission name the hub does not know decodes, grants nothing, and is listed by `unknownPermissions`. No hub reads them yet.

## 0.20.0

### Minor Changes

- [#1095](https://github.com/knpkv/npm/pull/1095) [`dae5d9d`](https://github.com/knpkv/npm/commit/dae5d9dc2cda82f5d54ba9ccb2d38d099b6ebfba) Thanks [@konopkov](https://github.com/konopkov)! - Hub apps run without nix. **Breaking change to the attached app contract** (even at 0.x): an attached app no longer takes `--socket <path>`, `HUB_URL` or `HUB_APP_TOKEN_FILE`. The hub starts each installed app itself as `<node> <prefix>/<bin> --attach` and writes one handshake line on its stdin (`HubHandshake`: the endpoint, a unix socket or a Windows named pipe; the hub's URL; a token and a secret, both fresh per start and never written to disk). The app reads it within 5 s (at most 4 KiB), listens on the endpoint, answers `403 not_hub` to any request without the spawn's `x-hub-app-secret` (compared in constant time, before any `x-hub-*` header is read), and stops when stdin ends. `serveAttached` reads the handshake from stdin; `readRunMode` takes argv only; `AttachedOptions.token` is a `Redacted` value. `apps.json` is v2 only (`AppsConfig`, `InstalledApp`): it names its one writer (`cli` or `nix`), trusted scopes, and per app the install prefix, the script (`hubApp.bin`, a path inside the package), whether it is enabled and its heap cap; v1 files are refused. An app's package.json declares `"hubApp": { "bin", "contract", "services" }` (`HubAppPackageField`). App states gain `starting`, `crashloop`, `disabled`, `install_missing` and `health`, and `AppStartError` gains `handshake`.

  The hub supervises its apps: one child per entry, restarted with backoff (1 s up to 60 s) after an exit or three missed health probes, left off after 5 exits in 10 minutes until restarted, stopped by closing stdin (killed after 5 s). Output goes to a per-app log (5 MB, one previous file kept). Tokens are per spawn, held in memory and revoked when that spawn ends. Sockets live in an owner-only runtime directory the hub wipes at start and refuses when another user owns it or others can enter it. On Windows file modes do nothing: owner-only state comes from the user profile's ACL, an owner-only pipe DACL is not attempted, and the per-spawn secret is the check. `@knpkv/herdr-fleet`'s `HubPaths` gains `hubData`, `hubState` and `hubRuntime` (`null` on Windows). `herdr-usage` attaches the same way, and its package.json declares `hubApp` (`dist/bin.js`, contract 1, `fleet.read` and `host`).

## 0.19.0

### Minor Changes

- [#1086](https://github.com/knpkv/npm/pull/1086) [`9182b48`](https://github.com/knpkv/npm/commit/9182b480640c95dae7d97faa4b1b8b62583dc938) Thanks [@konopkov](https://github.com/konopkov)! - hostd starts on Windows. Paths come from one `HubPaths` table shared by herdr-fleet and herdr-hub: the home directory is `os.homedir()` instead of `HOME`, the host name is `os.hostname()` instead of `HOSTNAME` (so a standalone host started without `HOSTNAME` now reports its real name instead of `localhost`), and Windows keeps fleet configuration under `%APPDATA%` and state under `%LOCALAPPDATA%`. Linux and macOS paths are unchanged. `HERDR_HUB_HOME` and `HERDR_HUB_CONFIG` override them on any OS. The job store's path-identity check now accepts a Windows real path that differs only in drive-letter case or separators. On Windows, hostd runs npm `.cmd` shims as Node with their script, never through a shell. `makeHostdProgram` takes an optional `paths` table.

  The Relay store notes that on Windows owner-only comes from the user profile's ACL.

## 0.18.0

### Minor Changes

- [#1059](https://github.com/knpkv/npm/pull/1059) [`82ed117`](https://github.com/knpkv/npm/commit/82ed117458771d21b61c4c5a4b66b2a9df44a64a) Thanks [@konopkov](https://github.com/konopkov)! - Tell a computer without Herdr from one whose Herdr isn't running, and tidy the standalone hub.

  - Breaking type change in `@knpkv/herdr-fleet`: `HostDetails` and `HostStatus` carry one `repository` object (`{ path, branch, revision, dirty }`, or `null` on a standalone computer) that replaces the separate `branch`, `revision` and `dirty` fields.
  - `AgentInventory` gains an optional `unavailableReason` (`herdr_not_installed` or `herdr_not_running`), and Connect's peer failure reasons gain the same two values. hostd reports a missing Herdr command as not installed and a list command that fails as not running.
  - Connect on a standalone computer shows "Herdr isn't installed" or "Herdr isn't running" (with Retry) instead of "localhost didn't answer", and its empty state names this computer.
  - `FleetService` refuses jobs a host has not set up at run time too, whatever composed its operations.
  - A configuration file that a case-insensitive volume lists under another case is read, not replaced by standalone defaults.

## 0.17.0

### Minor Changes

- [#1048](https://github.com/knpkv/npm/pull/1048) [`4c214b7`](https://github.com/knpkv/npm/commit/4c214b749c52cf37087a5b68e8e7269192def46c) Thanks [@konopkov](https://github.com/konopkov)! - hostd starts without a fleet configuration. When no file exists at the configuration path, it runs as a standalone local hub: fleet off, the super-app on `http://127.0.0.1:4778/`, the work listener on 127.0.0.1:4777, no tailnet, TLS or push. State lives in `$XDG_STATE_HOME/fleet`, else `$HOME/.local/state/fleet`, and the host is named from `HOSTNAME`. It prints one stderr line naming the path it looked for. An existing file that is unreadable, malformed or invalid still stops startup. `@knpkv/herdr-fleet` adds `standaloneDefaults`, `loadConfigurationOrStandalone`, `standaloneRefusedKinds` and `HostOperations.notSetUp`; a standalone computer refuses `nix.check`, `nix.apply` and `agent.delegate` before a job exists ("nix jobs are not set up on this computer", "agent delegation is not set up on this computer"). Only the default path falls back: an explicit `FLEET_CONFIG_PATH` with no file, or a dangling symlink at either path, still stops startup. A `lanWork` listener, when configured by a caller, still binds its own address on a standalone host. `HostDetails` (and so `HostStatus`) has nullable `repository`, `branch` and `revision`: a standalone computer has no fleet repository, reports none without running git, and the dashboard shows "No repository".

## 0.16.0

### Minor Changes

- [#1026](https://github.com/knpkv/npm/pull/1026) [`3404bcf`](https://github.com/knpkv/npm/commit/3404bcfcd50821a3bf3a30f99ca4b3fb2dd11ac2) Thanks [@konopkov](https://github.com/konopkov)! - Bind `sandbox.reset` and `sandbox.budget.lift` approvals to the pool record observed at submit. The owner host stamps its version, state, and lease holder and end, and execution rejects the job when that record has moved. A leased `endsAt` has to be a parseable UTC instant.

- [#1026](https://github.com/knpkv/npm/pull/1026) [`3404bcf`](https://github.com/knpkv/npm/commit/3404bcfcd50821a3bf3a30f99ca4b3fb2dd11ac2) Thanks [@konopkov](https://github.com/konopkov)! - Add the sandbox read model (`@knpkv/sandbox-pool/host` and `./host/server`) and the hub's Sandboxes module. A quarantine or run blocker is a closed tag (`ResourcesRemain`, `NukeFailed`, `BudgetHold`, `ScanIncomplete`, or `Unknown`) with fixed copy; the stored reset line is not served. `RELAY_SANDBOXES_HOST` plus an optional `sandboxPool` configuration select the hub that opens the pool database and serves overview and paged runs. Needs-you gains an `asOf` per provider, module-page destinations, and quarantined and budget-hold items. A host that does not own the pool contributes nothing. A reader that cannot start contributes a failed unavailable issue. This does not start pool jobs or the sweep, and it does not add the Sandboxes page.

## 0.15.0

### Minor Changes

- [#970](https://github.com/knpkv/npm/pull/970) [`4a47179`](https://github.com/knpkv/npm/commit/4a47179344419423632e32045c9e53d4dafa3bee) Thanks [@konopkov](https://github.com/konopkov)! - Add sandbox pool job kinds (lease, extend, release, approval-gated reset and budget lift) that only the pool's owning host runs, with fleetctl submission and approval display.

## 0.14.0

### Minor Changes

- [#966](https://github.com/knpkv/npm/pull/966) [`7603f36`](https://github.com/knpkv/npm/commit/7603f3641fb7d2658f93d4ce45d8949aeb9ecc35) Thanks [@konopkov](https://github.com/konopkov)! - Codex agents waiting on a sleep call now show as waiting instead of unknown. `AgentTaskFacts` activity gains a `wait` kind, which classifies as waiting while the call runs.

## 0.13.0

### Minor Changes

- [#963](https://github.com/knpkv/npm/pull/963) [`311bf0f`](https://github.com/knpkv/npm/commit/311bf0fd1c5a62de3fdb9a0142debbee2098eda0) Thanks [@konopkov](https://github.com/konopkov)! - Refuse delegated jobs whose repository is not an absolute path with `FleetRepositoryNotAbsoluteError`, and fail only the job whose restart recovery fails so hostd keeps starting.

## 0.12.0

### Minor Changes

- [#914](https://github.com/knpkv/npm/pull/914) [`48a942e`](https://github.com/knpkv/npm/commit/48a942e637e0fd0417027b3f1fae5400df5ce50b) Thanks [@konopkov](https://github.com/konopkov)! - Add the read-only Host resources module with local memory and CPU history, disk capacity, heavy-gate ownership, running jobs, preview listeners and memory by pane. Publish the shared snapshot schema and view, with independently unavailable sections and retained stale or offline readings.

  Add optional `heavyGate.lockDirectory` configuration without a default. Gate inspection follows inherited descriptors and reports bounded command display; it never changes jobs or locks. Preview protocol discovery runs separately from sampling and opens only verified tailnet DNS links.

## 0.11.0

### Minor Changes

- [#917](https://github.com/knpkv/npm/pull/917) [`485fe8f`](https://github.com/knpkv/npm/commit/485fe8f4db2c273ca85181d3712609ed1661bbce) Thanks [@konopkov](https://github.com/konopkov)! - Add typed, debounced agent task kinds to Fleet inventory and status. The host adapter supplies lifecycle evidence; unsupported tool and Work/CI evidence remains unknown. Only CI and test/build failures can produce the failing kind.

## 0.10.1

### Patch Changes

- Updated dependencies [[`c7fa96b`](https://github.com/knpkv/npm/commit/c7fa96be781457406e8de323bffdd9e137e66127)]:
  - @knpkv/bounded-io@0.3.0

## 0.10.0

### Minor Changes

- [#787](https://github.com/knpkv/npm/pull/787) [`3ba4e78`](https://github.com/knpkv/npm/commit/3ba4e78663b026f101f929ef41294a48b6bafc5a) Thanks [@konopkov](https://github.com/konopkov)! - Check explicit durable operation rejection before settling an unaccepted Fleet job, including on restart recovery. Store bounded cause-tagged errors for definitively uncommitted failures while preserving recovery for uncertain outcomes and accepted receipts.

  Validate optional delegate `newWork` branches and goal titles, bind both fields into the approval hash, and show the proposed goal in approvals, the dashboard, and fleetctl output so approval covers the goal that delegation will create. Failed job and follow output retain the operation error.

  Keep credential-redacted Unicode titles decodable at the length boundary, and escape terminal controls in shared fleetctl job, follow, and pending-submit output so untrusted fields cannot alter terminal presentation.

- [#759](https://github.com/knpkv/npm/pull/759) [`8017b49`](https://github.com/knpkv/npm/commit/8017b490395ea15e3949b946ebe8f5313b5d165b) Thanks [@konopkov](https://github.com/konopkov)! - Restrict the unauthenticated Work-only listener to loopback. `workBindAddress` now accepts only `127.0.0.0/8` addresses, and the listener refuses Work snapshot and checkpoint requests from any non-loopback peer. Paired LAN access remains available through `lanWork`.

## 0.9.0

### Minor Changes

- [#698](https://github.com/knpkv/npm/pull/698) [`586f75d`](https://github.com/knpkv/npm/commit/586f75d4b65e6d3c3b3f41f35d1b1a34facdb133) Thanks [@konopkov](https://github.com/konopkov)! - hostd serves Claude and Codex limits for Connect. Set the optional `agentUsageLimitsCommand` in the fleet configuration to `agent-usage limits`. `GET /v1/connect/limits` then returns this host's read, and on the hub every peer's read too. herdr-connect exports the wire schemas (`HostLimits`, `FleetLimits`) and the fleet collection. A host that can't read its limits says why instead of reporting zero.

## 0.8.0

### Minor Changes

- [#626](https://github.com/knpkv/npm/pull/626) [`da04e85`](https://github.com/knpkv/npm/commit/da04e85df105627acbfcc017ee0f15e6f4d6f20d) Thanks [@konopkov](https://github.com/konopkov)! - Job-store writes (`put`, `transition`) that lose the SQLite write lock to another connection now fail with the new `FleetStoreBusyError` instead of `FleetStoreError`. Nothing was written, so the same request can be retried. Every `FleetService` method that writes a job (approve, reject, run and the rest) can now fail with it.

## 0.7.0

### Minor Changes

- [#590](https://github.com/knpkv/npm/pull/590) [`69eb086`](https://github.com/knpkv/npm/commit/69eb08644a3b9e39ba97fd0205a985e5e7208a26) Thanks [@konopkov](https://github.com/konopkov)! - Work activity for an approved reassignment or abandonment reads as a sentence: "Reassigned from host-coordinator to claude-coordinator: <reason>" and "Abandoned: <reason>". Owner ids and the approval's job id and hash no longer appear in the text; they stay structured on the reassignment and abandonment records. `workReassignActivitySummary` and `workAbandonActivitySummary` now take only the payload. Events already recorded keep their earlier text.

## 0.6.1

### Patch Changes

- [#529](https://github.com/knpkv/npm/pull/529) [`b791563`](https://github.com/knpkv/npm/commit/b791563a328c0118c2716bda59294f7c606225c8) Thanks [@konopkov](https://github.com/konopkov)! - `fleetctl --help`, `fleetctl help` and `fleetctl work --help` now print plain usage and exit 0, even on a machine without a fleet configuration. A mistake now gets one line naming its cause, and a non-zero exit. That covers an unknown command, missing arguments, an unknown host (the line lists the known hosts) and an unknown job kind (it lists the kinds). Usage mistakes print the usage that applies after that line, with no `FleetValidationError:` prefix. A missing configuration file is reported as `no fleet configuration at PATH; create it, or set FLEET_CONFIG_PATH to an existing file` instead of a platform error.

## 0.6.0

### Minor Changes

- [#523](https://github.com/knpkv/npm/pull/523) [`38c8af6`](https://github.com/knpkv/npm/commit/38c8af6a0094a1ebb5c6e673c74dc40c5733283f) Thanks [@konopkov](https://github.com/konopkov)! - New approval-bound `work.abandon` job, which moves one Work goal to `abandoned`. The payload names the goal, its exact owner, a reason and the goal's expected head. The job hash covers every field, and the job always needs approval. `WorkService.abandon` clears the blocker and records a status activity naming the approved job. It refuses a goal with an active lane (`WorkGoalLaneActiveError`, naming the lane), a goal that has already finished (`WorkGoalTerminalError`), a stale head and a different owner. An exact replay returns the stored result. `runWorkAbandon` executes the job only with a persisted approval. The hub shows its fields, history and dashboard label, and `fleetctl submit HOST work.abandon PAYLOAD_JSON` submits it.

## 0.5.1

### Patch Changes

- [#469](https://github.com/knpkv/npm/pull/469) [`0fd9544`](https://github.com/knpkv/npm/commit/0fd95449194e83de61109d432224acc043f57964) Thanks [@konopkov](https://github.com/konopkov)! - New `@knpkv/bounded-io` package: `limitBytes`, `collectBounded` and `collectBoundedText` read a stream under a byte budget and fail with `ByteLimitExceeded` on the chunk that crosses it. The AI CLI runners and the Herdr command, terminal, Tailscale and HTTP-body readers now use it instead of their own copies; their errors and limits are unchanged, and collection is linear instead of quadratic in the number of chunks.
- Updated dependencies [[`0fd9544`](https://github.com/knpkv/npm/commit/0fd95449194e83de61109d432224acc043f57964)]:
  - @knpkv/bounded-io@0.2.0

## 0.5.0

### Minor Changes

- [#463](https://github.com/knpkv/npm/pull/463) [`2df424b`](https://github.com/knpkv/npm/commit/2df424b8e9c2b33dbb59a34954d84b2ff8903b1e) Thanks [@konopkov](https://github.com/konopkov)! - Every `node:sqlite` Herdr store now opens its database through the new `@knpkv/herdr-fleet/sqlite` opener. An existing group/other-writable state directory or database is now refused at startup and left unchanged; previously the approval store quietly restricted it before Work could refuse it, and `jobs.sqlite` was never checked. `WorkStore.open` now restricts an existing state directory to `0700`, as the other stores already did. The coordinator's orchestrator database reuses the shared path checks with no behaviour change.

## 0.4.0

### Minor Changes

- [#452](https://github.com/knpkv/npm/pull/452) [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade to Effect 4.0.0 stable. `effect` and every `@effect/*` dependency or peer dependency now require `4.0.0`; imports move from the removed `effect/unstable/*` paths to `effect/*`.

- [#446](https://github.com/knpkv/npm/pull/446) [`9f0be07`](https://github.com/knpkv/npm/commit/9f0be0719005ffd72466345bb8db27a98197451e) Thanks [@konopkov](https://github.com/konopkov)! - Recover an existing unlinked canonical Work goal through a read-only recovery context and preflight, then an approved, history-guarded recovery that links it to an exact worker without rewriting its original checkpoint. Accept the exact legacy worktree repository representation, add prospective PR admission preflight, and expose the recovery and admission routes through fleetctl and the approvals HTTP API. Add typed work.admit, work.recover and work.reconcile Fleet operations, which a host accepts at submission only when its composed Work adapter declares them in `HostOperations.workJobKinds`, and bot-review and formal-review evidence in pull-request evidence.

- [#419](https://github.com/knpkv/npm/pull/419) [`7b8fddb`](https://github.com/knpkv/npm/commit/7b8fddbabe360b01b2f09d1cc223f04463053949) Thanks [@konopkov](https://github.com/konopkov)! - Expose a scoped hostd operations composer for durable coordinator injection, including crash-safe receipt recovery, bounded terminal summaries, and accepted job identity.

- [#451](https://github.com/knpkv/npm/pull/451) [`9895206`](https://github.com/knpkv/npm/commit/9895206c410f78370a5bd939a33a5fbb9d0b4b65) Thanks [@konopkov](https://github.com/konopkov)! - Queue `nix.*` and `agent.*` jobs submitted through the verified local hostd listener without approval; Work authority jobs and remote submissions still require approval.

- [#420](https://github.com/knpkv/npm/pull/420) [`3af6bb0`](https://github.com/knpkv/npm/commit/3af6bb0f49806fa651d27aa33db0377fd82f46bb) Thanks [@konopkov](https://github.com/konopkov)! - Harden every durable execution read against command, route, activity-key, linked-parent, orphan-replica, and running-worker binding mismatches before restoring Work authority.

  Add exact-worker recovery replay, queued delivery failure, accepted Work revision and bounded context handoffs, a required `transition_summary` delegate mode, and a typed failed-Luna Sol escalation reference for durable hostd adapters. Preserve valid subset lineages during v1 migration, reject duplicate dispatch replicas and unsupported or malformed persisted handoff versions, validate the complete persisted worker binding, its immutable lane/checkpoint companions, matching handoff goal, exact routed-metadata discriminator, linked terminally failed Luna parent, complete coordinator lifecycle, and a lane head at least as new as the activated binding before restoring revision authority, and validate current v2 dispatch and metadata replicas against the same handoff before readback. Current lane readback also preserves the binding goal, requires an exact immutable operation-ledger replica, and requires the complete claim to remain exact at the binding revision. Reject partial coordinator schemas before either v1 or v2 handoff readback, keep SQL Work DDL inside the fail-closed migration transaction, scope legacy companion reads to the migrated dispatch closure, require every routed Sol dispatch to retain a Work link, validate every modern metadata row against its exact dispatch command, activity key, route discriminator, and Work-link form, reject routed metadata without its dispatch, and require every modern routed dispatch to retain exactly one metadata row. Reject malformed or non-null Luna Work links without charging valid Luna-only history to the Work ledger bound, enforce migrated decision capacity after every legacy upgrade path, and expose stale Sol acceptance as `OrchestratorWorkRevisionConflictError` without a partial dispatch. Routed submissions and durable readback bind `consult` to Luna medium, `transition_summary` to Luna low, and `review` or `work` to Sol high, rejecting persisted command/route mismatches before restoring Work authority. Sol escalation accepts only explicit channel-free `review` and `work` agent-delegate commands. Fleet requires exact persisted-worker replay before recovery can report a terminal result and accepts relationship-free coordinator roots only for consultation and transition summaries.

- [#447](https://github.com/knpkv/npm/pull/447) [`742e9b5`](https://github.com/knpkv/npm/commit/742e9b51e9b7d7d32639744cfd433de164135069) Thanks [@konopkov](https://github.com/konopkov)! - Add the approval-gated `work.reassign` Fleet operation. It moves one Work goal, and its active lane, from the exact current owner to a new owner in one transaction guarded by the goal's expected head event. The request names the agent outcome explicitly: `set` moves the goal's agent target and rebinds a bound lane to the new worker, `clear` removes the target, and `keep` is accepted only when the goal has none. `set` is refused, with nothing written, when the agent is already the current target of another goal or the authoritative binding of another goal's lane. A shipped lane keeps its previous owner, and admission preflight treats each lane's latest binding as its authority, so a rebound lane still reads as existing for its new worker. The new checkpoint records who approved it, the activity summary is bounded before approval, and replaying the same approval job is idempotent. Approvals render every hash-bound field of the request, fleetctl can submit it, and `runWorkReassign` executes it from a composed host that declares `work.reassign` in `HostOperations.workJobKinds`. A host without that adapter refuses the job at submission. `canonicalJobPayload` exports the exact text bound into a job's approval hash. Every Work approval request now displays each of its hash-bound fields, including worker names and admission worker lineage.

  Follow-up, not covered here: lane claims and checkpoint appends can still change an owner without an approved reassignment.

## 0.3.0

### Minor Changes

- [#404](https://github.com/knpkv/npm/pull/404) [`beed20b`](https://github.com/knpkv/npm/commit/beed20b1255616223d74e244065b560c7407eec2) Thanks [@konopkov](https://github.com/konopkov)! - Add an opt-in read-only LAN Work listener with five-minute browser pairing.

- [#401](https://github.com/knpkv/npm/pull/401) [`be9feff`](https://github.com/knpkv/npm/commit/be9feff762ab43b39c887b39815a2959714d7364) Thanks [@konopkov](https://github.com/konopkov)! - Add a typed LAN Work listener for non-browser clients and route local Work commands through its fixed checkpoint and snapshot endpoints. This typed listener does not provide browser pairing: it intentionally serves only its typed JSON routes, with no same-origin page or cross-origin browser grant.

### Patch Changes

- [#413](https://github.com/knpkv/npm/pull/413) [`43f1174`](https://github.com/knpkv/npm/commit/43f1174633ebba9d6244156fffa23514c89b4c74) Thanks [@konopkov](https://github.com/konopkov)! - Accept the root coordinator as the started worker for coordinator-handled consult and chat jobs while retaining exact child-lineage requirements for delegated work.

## 0.2.0

### Minor Changes

- [#384](https://github.com/knpkv/npm/pull/384) [`ac866e9`](https://github.com/knpkv/npm/commit/ac866e98e1b69f22f63618f9189482a34171edd0) Thanks [@konopkov](https://github.com/konopkov)! - Publish the Herdr fleet protocol, Tailscale adapter, Connect terminal, coordinator chat, durable Work board, and shared approval host runtime as reusable packages.
