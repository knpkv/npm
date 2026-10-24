# @knpkv/herdr-hub

Released as `@knpkv/herdr-approvals` up to 0.18.0; the headings below are that package's history.

## 0.57.0

### Minor Changes

- [#1095](https://github.com/knpkv/npm/pull/1095) [`dae5d9d`](https://github.com/knpkv/npm/commit/dae5d9dc2cda82f5d54ba9ccb2d38d099b6ebfba) Thanks [@konopkov](https://github.com/konopkov)! - Hub apps run without nix. **Breaking change to the attached app contract** (even at 0.x): an attached app no longer takes `--socket <path>`, `HUB_URL` or `HUB_APP_TOKEN_FILE`. The hub starts each installed app itself as `<node> <prefix>/<bin> --attach` and writes one handshake line on its stdin (`HubHandshake`: the endpoint, a unix socket or a Windows named pipe; the hub's URL; a token and a secret, both fresh per start and never written to disk). The app reads it within 5 s (at most 4 KiB), listens on the endpoint, answers `403 not_hub` to any request without the spawn's `x-hub-app-secret` (compared in constant time, before any `x-hub-*` header is read), and stops when stdin ends. `serveAttached` reads the handshake from stdin; `readRunMode` takes argv only; `AttachedOptions.token` is a `Redacted` value. `apps.json` is v2 only (`AppsConfig`, `InstalledApp`): it names its one writer (`cli` or `nix`), trusted scopes, and per app the install prefix, the script (`hubApp.bin`, a path inside the package), whether it is enabled and its heap cap; v1 files are refused. An app's package.json declares `"hubApp": { "bin", "contract", "services" }` (`HubAppPackageField`). App states gain `starting`, `crashloop`, `disabled`, `install_missing` and `health`, and `AppStartError` gains `handshake`.

  The hub supervises its apps: one child per entry, restarted with backoff (1 s up to 60 s) after an exit or three missed health probes, left off after 5 exits in 10 minutes until restarted, stopped by closing stdin (killed after 5 s). Output goes to a per-app log (5 MB, one previous file kept). Tokens are per spawn, held in memory and revoked when that spawn ends. Sockets live in an owner-only runtime directory the hub wipes at start and refuses when another user owns it or others can enter it. On Windows file modes do nothing: owner-only state comes from the user profile's ACL, an owner-only pipe DACL is not attempted, and the per-spawn secret is the check. `@knpkv/herdr-fleet`'s `HubPaths` gains `hubData`, `hubState` and `hubRuntime` (`null` on Windows). `herdr-usage` attaches the same way, and its package.json declares `hubApp` (`dist/bin.js`, contract 1, `fleet.read` and `host`).

### Patch Changes

- Updated dependencies [[`dae5d9d`](https://github.com/knpkv/npm/commit/dae5d9dc2cda82f5d54ba9ccb2d38d099b6ebfba), [`4914da5`](https://github.com/knpkv/npm/commit/4914da56c3e97101a3cbf9ad1cc649cfa5a526e6)]:
  - @knpkv/hub-app@0.4.0
  - @knpkv/herdr-fleet@0.20.0
  - @knpkv/herdr-usage@0.1.1
  - @knpkv/sandbox-pool@0.10.1
  - @knpkv/herdr-connect@0.31.1
  - @knpkv/herdr-coordinator@0.4.12
  - @knpkv/herdr-work@0.12.13

## 0.56.0

### Minor Changes

- [#1090](https://github.com/knpkv/npm/pull/1090) [`f944a82`](https://github.com/knpkv/npm/commit/f944a82348e827bcfbde71f548cdfb0e3e673c47) Thanks [@konopkov](https://github.com/konopkov)! - The hub signs in to AWS itself: `makeAwsSignIn` runs the IAM Identity Center device code sign-in, keeps its tokens in a private database instead of `~/.aws`, and refreshes them; `awsRoleCredentials` turns that sign-in into `Credentials` for one account and permission set. Both are exported from `@knpkv/herdr-hub/hostd-runtime`.

### Patch Changes

- Updated dependencies [[`3486fa2`](https://github.com/knpkv/npm/commit/3486fa2b9c9a65ae0782d24d6115ee94fc78071d)]:
  - @knpkv/hub-app@0.3.1

## 0.55.0

### Minor Changes

- [#1084](https://github.com/knpkv/npm/pull/1084) [`b323fee`](https://github.com/knpkv/npm/commit/b323fee9abea9aaf6fd4913465ef23f6830fca5e) Thanks [@konopkov](https://github.com/konopkov)! - Add `@knpkv/herdr-usage`: `./host` holds this machine's agent-usage readings (moved from herdr-hub, which now
  imports them), `./views` holds the Usage Limits views (also moved from herdr-hub, whose Usage page now renders
  them from here), `./selection` the page's selectors, and the package root holds the Usage
  app's server, whose limits and usage reads come from the
  hub's fleet reads when attached and from this machine when standalone. The hub now answers `fleet.read` for apps.
  `ShellContext` gains optional `headerOutlet` and `setHeaderMode` for apps that group their own header content
  with the shell's. The standalone shell now serves rly's tokens and base itself (`/app/shell.css`, linked by a hash
  of its text and cached for good), so an app's `client.css` carries only its own scoped styles, and it sets
  `data-app` on every element it lends the app (header slot and outlet, portal root) as well as the mount root. The
  Usage page's CSS moved with its views to `@knpkv/herdr-usage/views.css`, scoped under `[data-app="usage"]`; the hub
  imports it and marks its Usage module and header outlet with `data-app`. Grants minted for a GET can no longer post to Relay as the caller, a redirect to the app's own root
  stays under its `/apps/<id>/` prefix, and a burst of failed requests to one app runs a single re-probe.
  `@knpkv/herdr-connect/usage` now exports the `FleetLimits` and `FleetUsage` schemas as values, so a browser client
  decodes them without the package root. The Usage page (`UsagePage`) moved to `@knpkv/herdr-usage/views` behind a
  small `UsageShell`; the hub's Usage module renders it unchanged, and the app's own client and `herdr-usage`
  executable render the same page standalone or attached. `herdr-usage` runs the installed agent-usage with its own
  node by default, and refuses a malformed `HERDR_USAGE_LIMITS_COMMAND` instead of ignoring it.

- [#1089](https://github.com/knpkv/npm/pull/1089) [`8077a87`](https://github.com/knpkv/npm/commit/8077a87bffe9ac852f622ff6db5662970900ee66) Thanks [@konopkov](https://github.com/konopkov)! - Live AWS adapters for the sandbox pool: `makeStsPoolAccess`, `makeAwsNuke` and `makeOrganizationsBudgetLift` in `@knpkv/sandbox-pool/aws`, with `observeBaseline` and `planBaseline` for a read-only check. The `BudgetControl` port and `BudgetLiftFailed` move to `@knpkv/sandbox-pool`; `@knpkv/herdr-hub/hostd-runtime` still exports both.

### Patch Changes

- [#1091](https://github.com/knpkv/npm/pull/1091) [`df8ac0d`](https://github.com/knpkv/npm/commit/df8ac0dfdb5787065153cbe864272938f96c8c3d) Thanks [@konopkov](https://github.com/konopkov)! - Page metadata no longer has `showInPhoneTitle`: it was deprecated and ignored. A descriptor from an older app that still sends it decodes with the flag dropped; a descriptor literal typed as `ModuleDescriptor` that still writes it fails to compile with an excess-property error, so remove the flag from your descriptors. On a cold load the Hub's arrival focus lands on the page without painting a focus ring on a tab nobody reached by keyboard; the next Tab shows it as before.
- Updated dependencies [[`b323fee`](https://github.com/knpkv/npm/commit/b323fee9abea9aaf6fd4913465ef23f6830fca5e), [`e416078`](https://github.com/knpkv/npm/commit/e416078e075534f4681be5962e40c502492bfd71), [`df8ac0d`](https://github.com/knpkv/npm/commit/df8ac0dfdb5787065153cbe864272938f96c8c3d), [`8077a87`](https://github.com/knpkv/npm/commit/8077a87bffe9ac852f622ff6db5662970900ee66)]:
  - @knpkv/herdr-usage@0.1.0
  - @knpkv/hub-app@0.3.0
  - @knpkv/herdr-connect@0.31.0
  - @knpkv/sandbox-pool@0.10.0

## 0.54.0

### Minor Changes

- [#1078](https://github.com/knpkv/npm/pull/1078) [`0d60032`](https://github.com/knpkv/npm/commit/0d60032bdda09409bf752f56184626a85ced7d7f) Thanks [@konopkov](https://github.com/konopkov)! - On phones the Hub header shows the product name, a breadcrumb line under it names the module and page ("Fleet / Approvals"; the module alone when it has one page), and every module shows its heading and one-line purpose again. Page metadata `showInPhoneTitle` is deprecated and ignored.

- [#1086](https://github.com/knpkv/npm/pull/1086) [`9182b48`](https://github.com/knpkv/npm/commit/9182b480640c95dae7d97faa4b1b8b62583dc938) Thanks [@konopkov](https://github.com/konopkov)! - hostd starts on Windows. Paths come from one `HubPaths` table shared by herdr-fleet and herdr-hub: the home directory is `os.homedir()` instead of `HOME`, the host name is `os.hostname()` instead of `HOSTNAME` (so a standalone host started without `HOSTNAME` now reports its real name instead of `localhost`), and Windows keeps fleet configuration under `%APPDATA%` and state under `%LOCALAPPDATA%`. Linux and macOS paths are unchanged. `HERDR_HUB_HOME` and `HERDR_HUB_CONFIG` override them on any OS. The job store's path-identity check now accepts a Windows real path that differs only in drive-letter case or separators. On Windows, hostd runs npm `.cmd` shims as Node with their script, never through a shell. `makeHostdProgram` takes an optional `paths` table.

  The Relay store notes that on Windows owner-only comes from the user profile's ACL.

- [#1083](https://github.com/knpkv/npm/pull/1083) [`7cdf497`](https://github.com/knpkv/npm/commit/7cdf497c1c9efd089f1451f62c82b48e87238071) Thanks [@konopkov](https://github.com/konopkov)! - Sandboxes run details show each step's own status with its second line ("signed in", "41 to remove, scan complete", "3 still removable", "not run"), the failure in plain words, and the step times on the account page. Runs now record the dry run and verify counts, and `SandboxRunView` carries `steps`.

### Patch Changes

- Updated dependencies [[`0d60032`](https://github.com/knpkv/npm/commit/0d60032bdda09409bf752f56184626a85ced7d7f), [`9182b48`](https://github.com/knpkv/npm/commit/9182b480640c95dae7d97faa4b1b8b62583dc938), [`7cdf497`](https://github.com/knpkv/npm/commit/7cdf497c1c9efd089f1451f62c82b48e87238071)]:
  - @knpkv/codecommit-web@0.40.0
  - @knpkv/hub-app@0.2.0
  - @knpkv/herdr-fleet@0.19.0
  - @knpkv/relay@0.2.3
  - @knpkv/sandbox-pool@0.9.0
  - @knpkv/herdr-connect@0.30.1
  - @knpkv/herdr-coordinator@0.4.11
  - @knpkv/herdr-work@0.12.12

## 0.53.0

### Minor Changes

- [#1074](https://github.com/knpkv/npm/pull/1074) [`dae568e`](https://github.com/knpkv/npm/commit/dae568ebc64e075fdca77fa0cfb886078ad34038) Thanks [@konopkov](https://github.com/konopkov)! - Sandboxes cards show this month's spend against the pool budget's alarm and hard stop. The sweep reads it through a new host-supplied `SpendReader` and keeps each account's latest reading. There is no bar without a reader or without `spend` limits in the pool contract.

### Patch Changes

- Updated dependencies [[`c639c6e`](https://github.com/knpkv/npm/commit/c639c6e59a75ae32a7d6ce5bfc8a5af52ce912d4), [`0a4778e`](https://github.com/knpkv/npm/commit/0a4778e54f8a93bbbbe4b3c982459ff3a7bcec4d), [`dae568e`](https://github.com/knpkv/npm/commit/dae568ebc64e075fdca77fa0cfb886078ad34038)]:
  - @knpkv/codecommit-web@0.39.3
  - @knpkv/sandbox-pool@0.8.0

## 0.52.0

### Minor Changes

- [#1073](https://github.com/knpkv/npm/pull/1073) [`b207797`](https://github.com/knpkv/npm/commit/b207797126eeebea22ca2b8bec4b34bbfeae5ce7) Thanks [@konopkov](https://github.com/konopkov)! - Add `@knpkv/hub-app`: the contract and runner for apps that run standalone on their own port and mount in the
  hub. An app is its own process: `runApp` serves it on loopback with an owner login, or on a unix socket the hub
  proxies to. The hub reads installed apps from `~/.config/herdr/apps.json` (re-read when it changes and every 30
  seconds), probes each app's manifest, keeps the last good one, and lists every app's state at `GET /v1/apps`. It
  proxies `/apps/<id>/*` with the caller and a single-use grant, and serves app-to-hub services under
  `/v1/app-services/*` with a per-app token. An app that is down, incompatible or misdeclared is marked
  unavailable and never stops the hub. The module contract and route helpers moved to `@knpkv/hub-app`;
  `@knpkv/herdr-hub/modules` and `/modules/server` re-export them for one release.

- [#1070](https://github.com/knpkv/npm/pull/1070) [`a7359bb`](https://github.com/knpkv/npm/commit/a7359bba8ca51f1ec21c2726d8b54004ad4789f6) Thanks [@konopkov](https://github.com/konopkov)! - Usage Limits shows the hub's own tokens as its design draws them: one bar per period with its value printed, and a legend with each tool's total in text. A tool whose limits can't be read is left out of every total and named as excluded, and the title says which tools are counted. Reset times say "next" only a full week out and give the date for a reset already past.

- [#1070](https://github.com/knpkv/npm/pull/1070) [`a7359bb`](https://github.com/knpkv/npm/commit/a7359bba8ca51f1ec21c2726d8b54004ad4789f6) Thanks [@konopkov](https://github.com/konopkov)! - Usage Limits now reads like its design: one sentence on whether the hub has room for more work, notices for old or unreadable limits, and one card per tool with its level, state (near limit, limit reached, stale, sign-in required), limit track, resets and a note. A limit is "Sign-in required" only when the account needs a sign-in; any other unreadable limit reads Unknown with its cause, and a tool with no reading still gets an Unknown card. Resets on another day name the day. Loading and a failed first read keep their own simple states. The Limits page drops the host, range and time-zone controls; they stay on Tokens and By tool.

- [#1072](https://github.com/knpkv/npm/pull/1072) [`e4d6b79`](https://github.com/knpkv/npm/commit/e4d6b7959853f944345941b1e66f5bb4992dd7d5) Thanks [@konopkov](https://github.com/konopkov)! - A pool contract can name how people sign in (`access`: portal URL, SSO session, role). With it, the pool owner gets Open console and Copy CLI profile on the Sandboxes cards and account page.

  `PoolContract.regions` now accepts only AWS region codes such as `eu-central-1`.

### Patch Changes

- Updated dependencies [[`b207797`](https://github.com/knpkv/npm/commit/b207797126eeebea22ca2b8bec4b34bbfeae5ce7), [`e4d6b79`](https://github.com/knpkv/npm/commit/e4d6b7959853f944345941b1e66f5bb4992dd7d5)]:
  - @knpkv/hub-app@0.1.0
  - @knpkv/sandbox-pool@0.7.0

## 0.51.0

### Minor Changes

- [#1068](https://github.com/knpkv/npm/pull/1068) [`e084f5b`](https://github.com/knpkv/npm/commit/e084f5b9f57a35f35fb8ce2cd5383e633f063ab3) Thanks [@konopkov](https://github.com/konopkov)! - The pool owner's run detail shows the run's stored failure line and its last 30 log lines, read from a new owner-only `GET /v1/modules/sandboxes/run-log`.

### Patch Changes

- Updated dependencies [[`e084f5b`](https://github.com/knpkv/npm/commit/e084f5b9f57a35f35fb8ce2cd5383e633f063ab3)]:
  - @knpkv/sandbox-pool@0.6.0

## 0.50.0

### Minor Changes

- [#1064](https://github.com/knpkv/npm/pull/1064) [`d2d8b73`](https://github.com/knpkv/npm/commit/d2d8b73da7f3d60b6df0a63d1b84c6173b3b8846) Thanks [@konopkov](https://github.com/konopkov)! - The Sandboxes account page lets the owner ask Fleet to retry a quarantine's reset ("Retry reset") or lift a budget stop ("Request to lift the stop", also on the pool's budget card). `POST /v1/modules/sandboxes/jobs` takes `Retry` and `BudgetLift` orders, submitted as `sandbox.reset` (Retry) and `sandbox.budget.lift`, which always wait for an approval in Fleet / Approvals. The route refuses a request that could not run with 404 `not_found` or 409 `not_quarantined`, `not_budget_held` or `already_requested`, and `SandboxesWriteFailed` names those reasons. `SandboxesModuleWrites` gains `retry` and `liftBudget`. A later failed poll now keeps the requests and runs on screen, marked last known, instead of replacing them with a failure.

## 0.49.0

### Minor Changes

- [#1059](https://github.com/knpkv/npm/pull/1059) [`82ed117`](https://github.com/knpkv/npm/commit/82ed117458771d21b61c4c5a4b66b2a9df44a64a) Thanks [@konopkov](https://github.com/konopkov)! - Tell a computer without Herdr from one whose Herdr isn't running, and tidy the standalone hub.

  - Breaking type change in `@knpkv/herdr-fleet`: `HostDetails` and `HostStatus` carry one `repository` object (`{ path, branch, revision, dirty }`, or `null` on a standalone computer) that replaces the separate `branch`, `revision` and `dirty` fields.
  - `AgentInventory` gains an optional `unavailableReason` (`herdr_not_installed` or `herdr_not_running`), and Connect's peer failure reasons gain the same two values. hostd reports a missing Herdr command as not installed and a list command that fails as not running.
  - Connect on a standalone computer shows "Herdr isn't installed" or "Herdr isn't running" (with Retry) instead of "localhost didn't answer", and its empty state names this computer.
  - `FleetService` refuses jobs a host has not set up at run time too, whatever composed its operations.
  - A configuration file that a case-insensitive volume lists under another case is read, not replaced by standalone defaults.

- [#1061](https://github.com/knpkv/npm/pull/1061) [`74a7da5`](https://github.com/knpkv/npm/commit/74a7da57157079ce4b2810b3c1a8e4083c829d7b) Thanks [@konopkov](https://github.com/konopkov)! - Add the Sandboxes account page at `#sandboxes/account?id=` and the runs page at `#sandboxes/runs?id=`. The account page, where needs-you already links, shows a quarantine's blocker words, run id, since and failed step, a budget stop in caution words, and any reset or budget lift waiting in Fleet / Approvals with a link there. The runs page lists reason, outcome, duration and start, and a row opens that run with the failed step's blocker words. The overview puts quarantine first as the only red, then budget stops, and marks a pending request "Approval requested". New `GET /v1/modules/sandboxes/requests` lists pending sandbox resets and lifts with the requester's login, behind the module's authorization. `makeSandboxesModule` takes `pendingApprovals` in place of `pendingLifts`, and `SandboxesModuleReads` gains `runs` and `requests`.

### Patch Changes

- [#1058](https://github.com/knpkv/npm/pull/1058) [`6e333b2`](https://github.com/knpkv/npm/commit/6e333b2eb48d31f50284feb5e6813c5b801c121c) Thanks [@konopkov](https://github.com/konopkov)! - The README opens with "Run it on its own": `npx -y -p @knpkv/herdr-hub hostd` without a fleet configuration, its loopback ports 4778 and 4777, the stderr line it prints, and how `FLEET_CONFIG_PATH` switches it to a fleet host.

- [#1063](https://github.com/knpkv/npm/pull/1063) [`7fe0452`](https://github.com/knpkv/npm/commit/7fe0452202a1982e867c16d134f33b529183a320) Thanks [@konopkov](https://github.com/konopkov)! - `fleetctl status HOST` reads a host on an older hostd, whose status still has flat `branch`, `revision` and `dirty` fields. A Herdr spawn that fails because hostd's working directory is missing is no longer reported as "Herdr isn't installed". The not-running card's body says "Start Herdr, then retry.", matching its Retry button.
- Updated dependencies [[`82ed117`](https://github.com/knpkv/npm/commit/82ed117458771d21b61c4c5a4b66b2a9df44a64a), [`74a7da5`](https://github.com/knpkv/npm/commit/74a7da57157079ce4b2810b3c1a8e4083c829d7b)]:
  - @knpkv/herdr-fleet@0.18.0
  - @knpkv/herdr-connect@0.30.0
  - @knpkv/sandbox-pool@0.5.0
  - @knpkv/herdr-coordinator@0.4.10
  - @knpkv/herdr-work@0.12.11

## 0.48.0

### Minor Changes

- [#1048](https://github.com/knpkv/npm/pull/1048) [`4c214b7`](https://github.com/knpkv/npm/commit/4c214b749c52cf37087a5b68e8e7269192def46c) Thanks [@konopkov](https://github.com/konopkov)! - hostd starts without a fleet configuration. When no file exists at the configuration path, it runs as a standalone local hub: fleet off, the super-app on `http://127.0.0.1:4778/`, the work listener on 127.0.0.1:4777, no tailnet, TLS or push. State lives in `$XDG_STATE_HOME/fleet`, else `$HOME/.local/state/fleet`, and the host is named from `HOSTNAME`. It prints one stderr line naming the path it looked for. An existing file that is unreadable, malformed or invalid still stops startup. `@knpkv/herdr-fleet` adds `standaloneDefaults`, `loadConfigurationOrStandalone`, `standaloneRefusedKinds` and `HostOperations.notSetUp`; a standalone computer refuses `nix.check`, `nix.apply` and `agent.delegate` before a job exists ("nix jobs are not set up on this computer", "agent delegation is not set up on this computer"). Only the default path falls back: an explicit `FLEET_CONFIG_PATH` with no file, or a dangling symlink at either path, still stops startup. A `lanWork` listener, when configured by a caller, still binds its own address on a standalone host. `HostDetails` (and so `HostStatus`) has nullable `repository`, `branch` and `revision`: a standalone computer has no fleet repository, reports none without running git, and the dashboard shows "No repository".

- [#1036](https://github.com/knpkv/npm/pull/1036) [`f81d38a`](https://github.com/knpkv/npm/commit/f81d38a491b72e33878d454e0b33baa258bc2eb0) Thanks [@konopkov](https://github.com/konopkov)! - Add the Sandboxes overview page at `#sandboxes/overview`, between Host resources and Stacks. It shows the pool's cards in attention order with holder, time left and the 24-hour cap, cleanup steps, quarantine blockers, the last sweep, and lease, extend and release sheets. A failed read is one panel with Read again; a later failed read keeps the cards marked last known. The row appears only on the hub that serves the pool, read from the new `approvalApp.sandboxesEnabled` snapshot field. Until the hub can submit sandbox jobs, every viewer sees the pool read-only and the sheets point to the CLI.

- [#1051](https://github.com/knpkv/npm/pull/1051) [`c47f7aa`](https://github.com/knpkv/npm/commit/c47f7aa9bf961c04e6693d57cf860da7bec055e9) Thanks [@konopkov](https://github.com/konopkov)! - The Sandboxes page can lease, extend and release for the pool owner. `GET /v1/modules/sandboxes/caller` says who is reading and whether that is the hub's own node. `POST /v1/modules/sandboxes/jobs` takes `{ _tag: "Lease" }`, `{ _tag: "Extend", accountId }` or `{ _tag: "Release", accountId }` and submits the existing `sandbox.lease`, `sandbox.extend` or `sandbox.release` Fleet job as the caller. It answers 202 with the job id, 403 for any node but the hub's own, 409 when Fleet refuses the job, and 503 where the pool is not served. Like every module write, it requires the page's own origin. Every other viewer still sees the page read-only.

### Patch Changes

- Updated dependencies [[`4c214b7`](https://github.com/knpkv/npm/commit/4c214b749c52cf37087a5b68e8e7269192def46c), [`f81d38a`](https://github.com/knpkv/npm/commit/f81d38a491b72e33878d454e0b33baa258bc2eb0)]:
  - @knpkv/herdr-fleet@0.17.0
  - @knpkv/sandbox-pool@0.4.0
  - @knpkv/herdr-connect@0.29.8
  - @knpkv/herdr-coordinator@0.4.9
  - @knpkv/herdr-work@0.12.10

## 0.47.0

### Minor Changes

- [#1038](https://github.com/knpkv/npm/pull/1038) [`d9ab6d7`](https://github.com/knpkv/npm/commit/d9ab6d7deb3511dae6535557433c1d34b166c465) Thanks [@konopkov](https://github.com/konopkov)! - Serve the super-app on every host's loopback listener, not only on the notification hub. The dashboard snapshot's `approvalApp` gains `superapp` (this listener renders the super-app shell) and `fleet` (this host is in a fleet; a standalone host's shell has no Fleet module). Module descriptors list the new `local` listener. The tailnet TLS listener, push and agent reports stay on the notification hub; only the hub's loopback aggregates other hosts. Code and Stacks now say they are not set up "on this computer" rather than "on this hub"; a computer without Code shows that card instead of an empty queue form. On a standalone host the shell names "This computer", the sidebar is one group, and Connect reads neither fleet approvals nor push settings. The loopback Connect terminal opens only this host's sessions, only for a direct (unproxied) request: any local process that can reach the loopback can open a shell here, the same trust the loopback listener already carries. Other hosts' terminals stay on the tailnet listener.

### Patch Changes

- Updated dependencies [[`c2fdb19`](https://github.com/knpkv/npm/commit/c2fdb1980aa21778918ef054cefbc1103c8fbcc0), [`d9ab6d7`](https://github.com/knpkv/npm/commit/d9ab6d7deb3511dae6535557433c1d34b166c465)]:
  - @knpkv/alchemy-console@0.6.1
  - @knpkv/codecommit-web@0.39.1

## 0.46.0

### Minor Changes

- [#1020](https://github.com/knpkv/npm/pull/1020) [`7015e2c`](https://github.com/knpkv/npm/commit/7015e2cd1315f80a6198e62c0344bb41cb3d68dd) Thanks [@konopkov](https://github.com/konopkov)! - Review pages name commits by title and time instead of their ids. A commit reads as “Restore the draft on reconnect, 14:18” (with the date when it was not made the day of the reading); the full id is in the tooltip and behind a Copy commit id button.

  - `@knpkv/codecommit-core`: `CodeCommitReadClient.getCommit` reads a commit's title and commit time (`CodeCommitCommitSummary`), gated as the new `getCommit` read operation. It needs `codecommit:GetCommit`. Implementations of `CodeCommitReadClientService` must add the method.
  - `@knpkv/codecommit-web`: the owner API serves `GET /prs/:awsAccountId/:prId/commits/:commitId`, the host contract adds `CodeCommitSummary`, `CodeCommitQuery` and `CodeCommitSummaryResult`, and `CodeHostReads.commit` reads one commit per caller. The Relay findings label no longer prints a short head id; the exact head stays in the context body.
  - `@knpkv/review`: `CommitLabel`, `CommitSummaryProvider`, `useCommitSummaries` and `useCommitWords` from `@knpkv/review/react`, with styles at `@knpkv/review/commit-label.css`. The canvas uses them for its head and still-open lines, without the copy button inside the shrunk drawing.
  - `@knpkv/rly`: a `copy` icon.
  - `@knpkv/herdr-hub`: Code pages read commit titles through `/v1/modules/code/commit`.

- [#1013](https://github.com/knpkv/npm/pull/1013) [`81be299`](https://github.com/knpkv/npm/commit/81be299dee9eb62bce525bde6f106f5f54a58898) Thanks [@konopkov](https://github.com/konopkov)! - The host that owns the sandbox pool can run Fleet `sandbox.*` jobs. `openSandboxDatabase` keeps the pool's records and reset run log in one private SQLite database. `makeSandboxPool` runs lease, extend, release, reset and budget-lift jobs, with the job's actor as the lease holder and the reset inside the release or reset job, and a `sweepOnce` that expires leases and resumes interrupted resets. `withSandboxOperations` adds the jobs to a host's operations. Nothing is wired into hostd by default: the host supplies `PoolAccess`, `Nuke` and `BudgetControl`.

- [#1015](https://github.com/knpkv/npm/pull/1015) [`382cdd3`](https://github.com/knpkv/npm/commit/382cdd3c116c1b9d956c1ea55e4956eb10345178) Thanks [@konopkov](https://github.com/konopkov)! - Add `stacksModule` and the Stacks module server side: a read-only module that serves the host's alchemy stacks, one stack's state and its latest published plan from alchemy-console, on the host named by `RELAY_STACKS_HOST` only.

- [#1016](https://github.com/knpkv/npm/pull/1016) [`2ca72de`](https://github.com/knpkv/npm/commit/2ca72dec189c75ac63cb5f6f3d62540d92249ad2) Thanks [@konopkov](https://github.com/konopkov)! - Add the Stacks module to the hub: `#stacks/overview` lists the credential host's alchemy stacks grouped by app, with resource counts and each stage's latest CI-published plan, and `#stacks/stack` shows one stage's activity and its resources, state, outputs and plan. Read-only; it is served only by the hub named in `RELAY_STACKS_HOST` and says why it is unavailable anywhere else. Last apply, drift and approval gates read "Not checked yet" for now.

- [#1027](https://github.com/knpkv/npm/pull/1027) [`6140a40`](https://github.com/knpkv/npm/commit/6140a4020fa624365382fd8716592d33425c932d) Thanks [@konopkov](https://github.com/konopkov)! - Plan head, base and digest ids are copy buttons. The plan line and Stacks Activity show the words Head, Base and Digest. The short id is the button's name and the clipboard value, not the visible text.

- [#1026](https://github.com/knpkv/npm/pull/1026) [`3404bcf`](https://github.com/knpkv/npm/commit/3404bcfcd50821a3bf3a30f99ca4b3fb2dd11ac2) Thanks [@konopkov](https://github.com/konopkov)! - Bind `sandbox.reset` and `sandbox.budget.lift` approvals to the pool record observed at submit. The owner host stamps its version, state, and lease holder and end, and execution rejects the job when that record has moved. A leased `endsAt` has to be a parseable UTC instant.

- [#1026](https://github.com/knpkv/npm/pull/1026) [`3404bcf`](https://github.com/knpkv/npm/commit/3404bcfcd50821a3bf3a30f99ca4b3fb2dd11ac2) Thanks [@konopkov](https://github.com/konopkov)! - Add the sandbox read model (`@knpkv/sandbox-pool/host` and `./host/server`) and the hub's Sandboxes module. A quarantine or run blocker is a closed tag (`ResourcesRemain`, `NukeFailed`, `BudgetHold`, `ScanIncomplete`, or `Unknown`) with fixed copy; the stored reset line is not served. `RELAY_SANDBOXES_HOST` plus an optional `sandboxPool` configuration select the hub that opens the pool database and serves overview and paged runs. Needs-you gains an `asOf` per provider, module-page destinations, and quarantined and budget-hold items. A host that does not own the pool contributes nothing. A reader that cannot start contributes a failed unavailable issue. This does not start pool jobs or the sweep, and it does not add the Sandboxes page.

- [#1026](https://github.com/knpkv/npm/pull/1026) [`3404bcf`](https://github.com/knpkv/npm/commit/3404bcfcd50821a3bf3a30f99ca4b3fb2dd11ac2) Thanks [@konopkov](https://github.com/konopkov)! - Rename a stored sandbox when its contract keeps the account id and changes the name. The version and state stay, and an account that left the contract keeps its row. A rename whose stored version moved writes nothing.

### Patch Changes

- [#1028](https://github.com/knpkv/npm/pull/1028) [`65ee3f4`](https://github.com/knpkv/npm/commit/65ee3f4f155d0516416482bd039bc30ffb124e48) Thanks [@konopkov](https://github.com/konopkov)! - When the local project walk stops early, the Stacks overview says "The project walk stopped early, so projects already found are listed." The stacks found before the stop stay on the page. A local state file past its size limit does not use that sentence.

- [#1024](https://github.com/knpkv/npm/pull/1024) [`56c6996`](https://github.com/knpkv/npm/commit/56c6996b14b35f508ed83d2fd780d54f8dca1232) Thanks [@konopkov](https://github.com/konopkov)! - The Stacks overview no longer reports S3-backed stacks as unreadable. Their listing carries no resource count, which isn't a failure. Their resources now read "Not counted", and no stacks are named as unreadable. Source problems collapse to one line per cause, with what was skipped and how to fix it, for example "Sign-in expired for 8 AWS profiles, so their state buckets weren't read. Fix: run aws sso login for them on the stacks host." When nothing could be read, a single card names the cause and the fix.
- Updated dependencies [[`56c6996`](https://github.com/knpkv/npm/commit/56c6996b14b35f508ed83d2fd780d54f8dca1232), [`382cdd3`](https://github.com/knpkv/npm/commit/382cdd3c116c1b9d956c1ea55e4956eb10345178), [`e58ea2f`](https://github.com/knpkv/npm/commit/e58ea2f90e1b30580ab9eb201033ad21cfb09f11), [`65ee3f4`](https://github.com/knpkv/npm/commit/65ee3f4f155d0516416482bd039bc30ffb124e48), [`2ca72de`](https://github.com/knpkv/npm/commit/2ca72dec189c75ac63cb5f6f3d62540d92249ad2), [`7015e2c`](https://github.com/knpkv/npm/commit/7015e2cd1315f80a6198e62c0344bb41cb3d68dd), [`6140a40`](https://github.com/knpkv/npm/commit/6140a4020fa624365382fd8716592d33425c932d), [`bf62e19`](https://github.com/knpkv/npm/commit/bf62e19a1db55acd14169dbd315e694cc9e15e8a), [`3404bcf`](https://github.com/knpkv/npm/commit/3404bcfcd50821a3bf3a30f99ca4b3fb2dd11ac2), [`3404bcf`](https://github.com/knpkv/npm/commit/3404bcfcd50821a3bf3a30f99ca4b3fb2dd11ac2), [`3404bcf`](https://github.com/knpkv/npm/commit/3404bcfcd50821a3bf3a30f99ca4b3fb2dd11ac2)]:
  - @knpkv/alchemy-console@0.6.0
  - @knpkv/codecommit-web@0.39.0
  - @knpkv/review@0.7.0
  - @knpkv/rly@0.24.0
  - @knpkv/herdr-fleet@0.16.0
  - @knpkv/sandbox-pool@0.3.0
  - @knpkv/herdr-connect@0.29.6
  - @knpkv/herdr-work@0.12.9
  - @knpkv/relay-product@0.6.3
  - @knpkv/herdr-coordinator@0.4.8

## 0.45.0

### Minor Changes

- [#984](https://github.com/knpkv/npm/pull/984) [`f878a60`](https://github.com/knpkv/npm/commit/f878a60b1c00f5eda9db72488f749b5b322a6b03) Thanks [@konopkov](https://github.com/konopkov)! - Review canvas, phase 1: `@knpkv/review/canvas` and `@knpkv/review/canvas/react` add the canvas contracts, layout, zoom state and Rly view; the Code host reads a file-level TypeScript import graph and changed parts per revision; the Hub opens it with `view=canvas`.

### Patch Changes

- Updated dependencies [[`f878a60`](https://github.com/knpkv/npm/commit/f878a60b1c00f5eda9db72488f749b5b322a6b03)]:
  - @knpkv/review@0.6.0
  - @knpkv/codecommit-web@0.38.0

## 0.44.1

### Patch Changes

- [#992](https://github.com/knpkv/npm/pull/992) [`42817f7`](https://github.com/knpkv/npm/commit/42817f7bf9e1d01a97d655b5b97f5ecc82773cea) Thanks [@konopkov](https://github.com/konopkov)! - Pin that only the hub's own tailnet node, calling the hub server itself, is treated as a viewer on the hub machine: a hub-node WhoIs on another server, or another node on the hub, gets no Code owner UI link. The WhoIs-to-caller mapping is now one internal function shared by the listener and its tests.

## 0.44.0

### Minor Changes

- [#987](https://github.com/knpkv/npm/pull/987) [`1d9798a`](https://github.com/knpkv/npm/commit/1d9798a8f17bf00c036d5847f165badf308d7694) Thanks [@konopkov](https://github.com/konopkov)! - The Code page's "Open Code owner UI" link now works on the hub's tailnet URL, not only on loopback. The hub decides on the server: `/v1/modules/code/queue` returns `ownerUi` only when the request's WhoIs-authenticated tailnet node is the hub's own node (`approvalHub.nodeId`), never from `Host`, `X-Forwarded-*` or login headers. Module callers carry a server-computed `sameNode`, false unless an authorizer proves it.

## 0.43.0

### Minor Changes

- [#970](https://github.com/knpkv/npm/pull/970) [`4a47179`](https://github.com/knpkv/npm/commit/4a47179344419423632e32045c9e53d4dafa3bee) Thanks [@konopkov](https://github.com/konopkov)! - Add sandbox pool job kinds (lease, extend, release, approval-gated reset and budget lift) that only the pool's owning host runs, with fleetctl submission and approval display.

### Patch Changes

- Updated dependencies [[`d43f9c6`](https://github.com/knpkv/npm/commit/d43f9c6e3fb37b8569e73827f9d370a6d3368e12), [`4a47179`](https://github.com/knpkv/npm/commit/4a47179344419423632e32045c9e53d4dafa3bee)]:
  - @knpkv/codecommit-web@0.37.0
  - @knpkv/herdr-fleet@0.15.0
  - @knpkv/herdr-connect@0.29.3
  - @knpkv/herdr-coordinator@0.4.7
  - @knpkv/herdr-work@0.12.8

## 0.42.2

### Patch Changes

- [#966](https://github.com/knpkv/npm/pull/966) [`7603f36`](https://github.com/knpkv/npm/commit/7603f3641fb7d2658f93d4ce45d8949aeb9ecc35) Thanks [@konopkov](https://github.com/konopkov)! - Codex agents waiting on a sleep call now show as waiting instead of unknown. `AgentTaskFacts` activity gains a `wait` kind, which classifies as waiting while the call runs.
- Updated dependencies [[`7603f36`](https://github.com/knpkv/npm/commit/7603f3641fb7d2658f93d4ce45d8949aeb9ecc35)]:
  - @knpkv/herdr-fleet@0.14.0
  - @knpkv/herdr-connect@0.29.2
  - @knpkv/herdr-coordinator@0.4.6
  - @knpkv/herdr-work@0.12.7

## 0.42.1

### Patch Changes

- [#963](https://github.com/knpkv/npm/pull/963) [`311bf0f`](https://github.com/knpkv/npm/commit/311bf0fd1c5a62de3fdb9a0142debbee2098eda0) Thanks [@konopkov](https://github.com/konopkov)! - Refuse delegated jobs whose repository is not an absolute path with `FleetRepositoryNotAbsoluteError`, and fail only the job whose restart recovery fails so hostd keeps starting.
- Updated dependencies [[`311bf0f`](https://github.com/knpkv/npm/commit/311bf0fd1c5a62de3fdb9a0142debbee2098eda0)]:
  - @knpkv/herdr-fleet@0.13.0
  - @knpkv/herdr-connect@0.29.1
  - @knpkv/herdr-coordinator@0.4.5
  - @knpkv/herdr-work@0.12.6

## 0.42.0

### Minor Changes

- [#935](https://github.com/knpkv/npm/pull/935) [`a4d13af`](https://github.com/knpkv/npm/commit/a4d13af29b77e1b6b6752715799c219fd91070b2) Thanks [@konopkov](https://github.com/konopkov)! - Show recorded reviews and cached discussions on a full Code page with the PR header, checks and stacked pull-request diffs in the hub. Add read-only Review and Conversation views with severity groups, counted lower-priority disclosure, All/Findings/Comments index filters, stable thread links, retained-reading warnings and host-owned retries. Guide selections return to Review until a guide reader is available.

  Persist completed owner reviews with their original revisions. Keep the completed result visible when history cannot be saved, distinguish absent and unreadable history, and preserve Explain output and P0–P4 findings. Add bounded workspace contracts and exported read-only views that preserve recorded provenance, disposition, requirements and deleted comments without inventing missing data.

  Place findings only on matching revisions and verified diff lines; retain separate cards when placement is unavailable. Keep retry and rerun focus inside the workspace, preserve browser history and file selection, and announce accepted read completions without stealing focus.

  Make Rly an optional peer of `@knpkv/review` instead of a runtime dependency, keeping headless contract installs free of the UI dependency tree. Consumers of the React controls, guide placement or guide exports must install `@knpkv/rly` explicitly alongside the React peers.

### Patch Changes

- Updated dependencies [[`a4d13af`](https://github.com/knpkv/npm/commit/a4d13af29b77e1b6b6752715799c219fd91070b2)]:
  - @knpkv/codecommit-web@0.36.0

## 0.41.5

### Patch Changes

- [#960](https://github.com/knpkv/npm/pull/960) [`978c99a`](https://github.com/knpkv/npm/commit/978c99ae28cc8b4a967c68a8dd1f9017b6c8a02f) Thanks [@konopkov](https://github.com/konopkov)! - Usage Limits groups its page title and tabs with the shell header in every state, as the design's header region does, and draws that header to the design: 430 body type, 16px tab region, the phone tab inset, and hosts and notifications read before Ask Relay. The page heading is now a single screen-reader heading outside the header; on phones the visible title and lead are no longer shown in the header.

## 0.41.4

### Patch Changes

- [#958](https://github.com/knpkv/npm/pull/958) [`fb09f42`](https://github.com/knpkv/npm/commit/fb09f424ddd8b8b7b65fc71d6361dd7e2caca418) Thanks [@konopkov](https://github.com/konopkov)! - Pin `@effect/platform-node-shared` to the same release as `effect`. `@effect/platform-node` declares it with a caret range, so a fresh install picked up a newer release that imports `Path.make`, which `effect` 4.0.0 lacks. The CLI then failed at startup with npm or pnpm.
- Updated dependencies [[`fb09f42`](https://github.com/knpkv/npm/commit/fb09f424ddd8b8b7b65fc71d6361dd7e2caca418)]:
  - @knpkv/codecommit-web@0.35.3
  - @knpkv/herdr-coordinator@0.4.4

## 0.41.3

### Patch Changes

- Updated dependencies [[`31be523`](https://github.com/knpkv/npm/commit/31be52376da7100b172a8fc620f9c967892d01c3)]:
  - @knpkv/herdr-connect@0.29.0

## 0.41.2

### Patch Changes

- [#950](https://github.com/knpkv/npm/pull/950) [`d0498ba`](https://github.com/knpkv/npm/commit/d0498ba7b715ac86e2c15934467b039059df0e11) Thanks [@konopkov](https://github.com/konopkov)! - The desktop sidebar's design-conformance `nav` region is now the module list in every layout, as in the design, instead of the whole sidebar with its brand, Settings and session.

## 0.41.1

### Patch Changes

- [#946](https://github.com/knpkv/npm/pull/946) [`b27b391`](https://github.com/knpkv/npm/commit/b27b391fedf7eb1b4100557f54b204148d1fa895) Thanks [@konopkov](https://github.com/konopkov)! - Empty Usage Limits tabs stay Usage navigation: focus lands on the current tab and clicking it replaces history instead of pushing. Relay's status region stays mounted when Usage enters or leaves its empty layout, so an unchanged status is not announced again.

## 0.41.0

### Minor Changes

- [#929](https://github.com/knpkv/npm/pull/929) [`2801b6d`](https://github.com/knpkv/npm/commit/2801b6de0ba87ae085e2648d982b7ea62de595ed) Thanks [@konopkov](https://github.com/konopkov)! - Tag Usage Limits regions for design conformance and render its successful empty state with the designed notice and token-reading action. Other states retain their existing layout.

### Patch Changes

- Updated dependencies [[`2801b6d`](https://github.com/knpkv/npm/commit/2801b6de0ba87ae085e2648d982b7ea62de595ed)]:
  - @knpkv/herdr-connect@0.28.1

## 0.40.2

### Patch Changes

- [#940](https://github.com/knpkv/npm/pull/940) [`cbd2334`](https://github.com/knpkv/npm/commit/cbd2334f7c31866ca3384eacda6374500f008c1b) Thanks [@konopkov](https://github.com/konopkov)! - Align the Relay sidebar with its design: rows start on one glyph column with 17px glyphs for secondary modules and Settings, Settings uses the row gap, the wordmark keeps its own line box, and Host resources draws the design's chip glyph.

## 0.40.1

### Patch Changes

- Updated dependencies [[`ca9f6a2`](https://github.com/knpkv/npm/commit/ca9f6a23a0cfd6ab1fdd21804156791864fbef07)]:
  - @knpkv/herdr-connect@0.28.0

## 0.40.0

### Minor Changes

- [#923](https://github.com/knpkv/npm/pull/923) [`a1152b5`](https://github.com/knpkv/npm/commit/a1152b51e8819c16bf9513a45fa0804f481d21ad) Thanks [@konopkov](https://github.com/konopkov)! - Produce agent task kinds from bounded, host-private Claude/Codex session evidence and existing branch PR facts. Keep unsupported sources unknown and send only the normalized kind over the fleet wire.

## 0.39.0

### Minor Changes

- [#914](https://github.com/knpkv/npm/pull/914) [`48a942e`](https://github.com/knpkv/npm/commit/48a942e637e0fd0417027b3f1fae5400df5ce50b) Thanks [@konopkov](https://github.com/konopkov)! - Add the read-only Host resources module with local memory and CPU history, disk capacity, heavy-gate ownership, running jobs, preview listeners and memory by pane. Publish the shared snapshot schema and view, with independently unavailable sections and retained stale or offline readings.

  Add optional `heavyGate.lockDirectory` configuration without a default. Gate inspection follows inherited descriptors and reports bounded command display; it never changes jobs or locks. Preview protocol discovery runs separately from sampling and opens only verified tailnet DNS links.

### Patch Changes

- Updated dependencies [[`48a942e`](https://github.com/knpkv/npm/commit/48a942e637e0fd0417027b3f1fae5400df5ce50b)]:
  - @knpkv/herdr-fleet@0.12.0
  - @knpkv/herdr-connect@0.27.2
  - @knpkv/herdr-coordinator@0.4.3
  - @knpkv/herdr-work@0.12.4

## 0.38.0

### Minor Changes

- [#917](https://github.com/knpkv/npm/pull/917) [`485fe8f`](https://github.com/knpkv/npm/commit/485fe8f4db2c273ca85181d3712609ed1661bbce) Thanks [@konopkov](https://github.com/konopkov)! - Add typed, debounced agent task kinds to Fleet inventory and status. The host adapter supplies lifecycle evidence; unsupported tool and Work/CI evidence remains unknown. Only CI and test/build failures can produce the failing kind.

### Patch Changes

- Updated dependencies [[`485fe8f`](https://github.com/knpkv/npm/commit/485fe8f4db2c273ca85181d3712609ed1661bbce)]:
  - @knpkv/herdr-fleet@0.11.0
  - @knpkv/herdr-connect@0.27.1
  - @knpkv/herdr-coordinator@0.4.2
  - @knpkv/herdr-work@0.12.3

## 0.37.3

### Patch Changes

- Updated dependencies [[`6e3abc8`](https://github.com/knpkv/npm/commit/6e3abc863ecf98f1b367643421964743ab971459)]:
  - @knpkv/herdr-connect@0.27.0

## 0.37.2

### Patch Changes

- [#895](https://github.com/knpkv/npm/pull/895) [`fdbca63`](https://github.com/knpkv/npm/commit/fdbca63a2a259e25f61ad044feec713f8e1c0550) Thanks [@konopkov](https://github.com/konopkov)! - Add scoped, single-flight optional hue enrichment and bind it to the hub's server lifetime. Return an uncoloured directory when hue permission finalization exceeds its wait budget, while keeping mandatory activity observations independent. Shutdown interrupts the owned worker, joins for at most two seconds and closes its connection, logging a typed warning if uninterruptible cleanup remains pending.
- Updated dependencies [[`fdbca63`](https://github.com/knpkv/npm/commit/fdbca63a2a259e25f61ad044feec713f8e1c0550)]:
  - @knpkv/herdr-connect@0.26.0

## 0.37.1

### Patch Changes

- Updated dependencies [[`ab70d8a`](https://github.com/knpkv/npm/commit/ab70d8abd85e2470e0ad5667b8846e2d003e519e)]:
  - @knpkv/herdr-connect@0.25.0

## 0.37.0

### Minor Changes

- [#877](https://github.com/knpkv/npm/pull/877) [`6de50ff`](https://github.com/knpkv/npm/commit/6de50ff3b833224069a5e2b4460d762e94c98002) Thanks [@konopkov](https://github.com/konopkov)! - Recover Connect writes from short-lived SQLite writer contention. Use 100 ms native lock waits, followed by asynchronous exponential retries with jitter and an approximately five-second budget, replaying the whole atomic statement or IMMEDIATE transaction. Export ConnectStoreBusyError for exhaustion and classify the hub's additive 503 response contract as minor. Keep archive enrichment isolated, preserve safe inventory diagnostics, and return an exhausted report's operation and budget as HTTP 503 without its private cause. Preserve WAL, FULL synchronous mode and owner-only database and sidecar files; leave Work, Code and Fleet job settings unchanged. Optional archive passes on live directory reads stop at the first failure, limiting writer contention to one native wait for the whole fleet and invalidating absence evidence for skipped hosts. Parent-name and voice/self-state enrichment each have a 100 ms deadline. Directory and post-page reads filter retained rows without pruning. Post writes evict one global batch of at most 256 expired reports under the asynchronous write budget, including reports from agents that never write again, and trim only the writer to 128 entries. Physical expiry eviction waits for post writes; dormant fleets retain hidden expired rows until posting resumes. Equal-time observations cannot clear archive taint; recovery must be strictly newer. Optional failures remain isolated and logged, preserving the browser's directory deadline.

  Include transaction-permit queueing in the write deadline and retry SQLITE_LOCKED alongside SQLITE_BUSY. Preserve safe busy metadata for remote reporters, using the reporter timeout option on peer inventory reads while leaving ordinary directory deadlines unchanged. Stop a blocked-notification pass after its first store failure. New archive closure snapshots ignore expired reports, preserving the inclusive retention cutoff and existing recorded last words.

  Stop notification admission on subscription-store failures too, while draining already-reserved provider sends and recording their definite outcomes. Bound optional hue allocation to half the peer-directory deadline. Preserve typed busy responses in Relay post and self-state clients, without repeating an exhausted post or exposing the server-private cause.

  Request-facing hub stores use zero native lock waits and return typed failures immediately; Connect batch writers retain asynchronous retries. Export the shared report response deadline, derived from reporter inventory plus the primary write plus a transport margin, and use it in both report clients so exhausted busy responses arrive before cancellation.

  Serialize activity observations and optional hue allocations through one store-wide permit, including file-permission finalization. Preserve the existing queue-inclusive write and optional hue deadlines. Secure lazy WAL and SHM sidecars after post-page SELECTs without reintroducing read-path pruning.

  End the busy deadline after lock acquisition and SQL retries, before post-commit permission finalization. Keep the transaction permit through finalization without returning ConnectStoreBusyError for an already-committed write. Apply the same boundary to the optional hue lock budget.

### Patch Changes

- Updated dependencies [[`6de50ff`](https://github.com/knpkv/npm/commit/6de50ff3b833224069a5e2b4460d762e94c98002)]:
  - @knpkv/herdr-connect@0.24.0

## 0.36.0

### Minor Changes

- [#875](https://github.com/knpkv/npm/pull/875) [`5a8885c`](https://github.com/knpkv/npm/commit/5a8885c94067f1fcde10746ccc0bb2397333eaa6) Thanks [@konopkov](https://github.com/konopkov)! - Add explicit terminal takeover across devices. A controlled terminal offers Take over, including when all four controller slots are occupied; the previous device shows Taken over on another device with Reconnect. Keep Connecting during bounded cleanup and cancel pending admission when the stage closes. Preserve recovery-dialog focus through directory refreshes. Require fresh authenticated remote-host capability before forwarding takeover, preserving the controlled state on older hosts. Export optional takeover selection and the capability and takeover-close schemas.

  Ordinary reconnects wait for a closing controller's bounded release instead of being refused as already controlled. Live controllers remain exclusive; cancellation and newer takeovers retain the same cleanup barrier.

### Patch Changes

- Updated dependencies [[`5a8885c`](https://github.com/knpkv/npm/commit/5a8885c94067f1fcde10746ccc0bb2397333eaa6)]:
  - @knpkv/herdr-connect@0.23.0

## 0.35.0

### Minor Changes

- [#872](https://github.com/knpkv/npm/pull/872) [`8f2d743`](https://github.com/knpkv/npm/commit/8f2d743cc568d386801ef115628567eb3497005c) Thanks [@konopkov](https://github.com/konopkov)! - Persist per-agent hue families, resolve live-host collisions with shape-aware overflow, and serve retained family snapshots in the archive.

### Patch Changes

- Updated dependencies [[`8f2d743`](https://github.com/knpkv/npm/commit/8f2d743cc568d386801ef115628567eb3497005c)]:
  - @knpkv/herdr-connect@0.22.0

## 0.34.0

### Minor Changes

- [#870](https://github.com/knpkv/npm/pull/870) [`1ffd400`](https://github.com/knpkv/npm/commit/1ffd4002d82cb981cb203b77c67844002179bcf9) Thanks [@konopkov](https://github.com/konopkov)! - Add the Connect home descriptor and migrate hub destinations only when their source pages are retired and their replacement pages are installed. Connect stage, approval, Work and Usage selectors survive redirects, while the shell preserves foreign history state.

  Primary module links open their declared default page without resuming a previous object selection or filter. Module sections remain mounted while inactive; page-local state survives a page switch only when the pages render a shared owner component, as Fleet does.

  Add an optional discriminated Home presentation to ConnectSurface, with a host-owned summary above the directory. Fleet remains the default; directory reads, stage selection, pins and terminal callbacks keep one owner.

  Install Connect home as the canonical landing page, with flat installed-only sidebar and phone destinations, settings in More, and Fleet Approvals/Work through fleetHubModule. The standalone Fleet surface retains all four pages. Add typed primaryModules and optional FleetShell pages for canonical composition.

  Add Usage By tool from the existing reported host/tool/model data; unknown hosts never count as zero. Move the authenticated summary API to /v1/modules/connect/needs-you; the retired Today API returns 404. needsYouRouteOwner identifies the reserved collector route.

  Export one explicit Fleet/Home/push agent-group policy. Home includes Ready/Idle and truthful relationship labels, while Fleet's unknown-state fallback remains unchanged. Clearing filters in a hidden Connect owner no longer steals focus.

  Add optional agentStatePresentation policy and Creature statePolicy, defaulting to Fleet. Home's unknown agent has caution wording without a needs-you pose. Fleet host filtering matches host names case-insensitively, consistently with Home and selectors.

  Require SuperappShell session access and connection state from its composition. The footer distinguishes local/Tailscale access, retained readings while reconnecting, and an unreachable hub without claiming connected.

  Add ConnectSurface active (default true) for inactive embedded modules: release the stage portal and watched-agent presence while keeping saved selection, polls, pins and terminal/session ownership alive.

  Add the shell terminalOwnsKeys input so Connect Home retains Ask Relay summon keys until an active connected terminal reserves them; legacy Fleet Connect ownership is unchanged.

  Only the displayed Fleet limits footer owns its poll. Home performs no limits read; Fleet starts that read after the directory loads and the footer is shown, including its terminal presentation policy.

  Add optional ModuleViews.navigationBadge for owner-supplied bounded readings. Fleet uses its existing pending approvals, marks partial counts with a plus and stale counts as a previous reading, and shares expiry-aware counting with the app icon badge. Unknown readings have an accessible label without a visible zero badge. No unread notification count is claimed.

  The active Connect terminal keeps its existing full-screen layout, hides shell chrome from focus and accessibility, and restores the Home document scroll on return.

  Home's Done label uses the design's neutral shared check glyph through an additive AgentStateLabel statePolicy; Fleet retains its positive tone. Failed terminal focus transitions are announced with actionable words instead of internal reason codes.

  Add an optional Home empty-state slot and shell-owned openHostAccess mount callback. Empty Home links only to existing Fleet Work and Host access. Silent-host Home rows say Unknown with cached work and reported last-activity time; Fleet retains its last-known labels.

  Add an optional AgentStage presentation for Home navigation chrome. Phone Back and desktop Close use the existing selection close and focus-return path; Fleet's header and both stage bodies stay unchanged.

  Add optional module-page `showInPhoneTitle` metadata for designed phone mast labels.

  Connect Home retains Active/Archived navigation, including read-only closed stages and retained older-page recovery. The optional paired directoryLocation owns URL and navigation together; absent keeps standalone history unchanged. Embedded hub owners require that pair, build links from their saved Connect location and preserve shell/foreign history through the shell navigator. Inactive archive portals and expired-selection repair are suppressed while closure selection and loaded pages remain retained. Paging and retry transitions keep keyboard focus in the archive and move it to the new result or recovery control.

  The canonical Connect module forwards the dashboard notification state to its stage footer, avoiding a competing device-state read.

  Inactive Connect releases its document and viewport locks while retaining the terminal socket. Reactivation restores guarded terminal focus once. Leaving Active for Archived releases terminal ownership so shell chrome and summon keys recover. URL-selected stage close removes selectors through replace navigation without remounting the directory; a repeated incoming selection reopens it.

  Returning to a module keeps its owner's arrival focus, such as Work goal details. History traversal also preserves focus claimed inside the destination; explicit page-focus requests stay unchanged. URL-owned stages follow history selector changes and return focus to their agent row; local stages and filters remain owned by the retained directory.

  Empty Home keeps a compact Approvals unknown link when the independent approval reading is incomplete or failed. By tool retains its reported range during range updates and names failed retained readings with their timestamp and five-minute retry cadence.

  Controlled Connect locations also supply selection dismissal. Archived-stage Close consumes the shell-owned pushed entry, or replaces a direct/reloaded selection, so Back does not reopen it. Standalone history stays unchanged. Approval-count copy uses the singular noun for one waiting approval.

  Limit retry controls follow their owning Usage page. Home creature arrivals use Home's unknown-evidence policy, while Fleet keeps its safety fallback. Export normalized Connect URL-selection helpers shared by target resolution, retained terminal preference changes and stage ownership: unrelated query parameters or host-case changes keep the same terminal, and case-insensitive stage links clear their selectors on close.

### Patch Changes

- Updated dependencies [[`1ffd400`](https://github.com/knpkv/npm/commit/1ffd4002d82cb981cb203b77c67844002179bcf9), [`1ffd400`](https://github.com/knpkv/npm/commit/1ffd4002d82cb981cb203b77c67844002179bcf9)]:
  - @knpkv/herdr-connect@0.21.0
  - @knpkv/rly@0.23.0
  - @knpkv/codecommit-web@0.35.2
  - @knpkv/herdr-work@0.12.2
  - @knpkv/relay-product@0.6.2

## 0.33.3

### Patch Changes

- [#868](https://github.com/knpkv/npm/pull/868) [`8d5281d`](https://github.com/knpkv/npm/commit/8d5281daaa9bd9ef28d32004a88fca4c9f1d117b) Thanks [@konopkov](https://github.com/konopkov)! - Release terminal controller locks and connection slots after failed setup or a disconnected session, with a ten-second cleanup wait. Keep late finalizers owned by the hub, warn with only the host, agent ID and elapsed time, and preserve live-controller exclusivity and the four-controller limit.

## 0.33.2

### Patch Changes

- [#866](https://github.com/knpkv/npm/pull/866) [`9904bb8`](https://github.com/knpkv/npm/commit/9904bb8648a2bbc8275a2dbb65354648c44a429d) Thanks [@konopkov](https://github.com/konopkov)! - Stop archive reads after ten seconds with a typed timeout and Retry, without restarting the deadline on directory polls. Limit the directory's configured-host hint to the first 256 machines in configuration order so host metadata stays within the page schema's bound.
- Updated dependencies [[`9904bb8`](https://github.com/knpkv/npm/commit/9904bb8648a2bbc8275a2dbb65354648c44a429d)]:
  - @knpkv/herdr-connect@0.20.2

## 0.33.1

### Patch Changes

- Updated dependencies [[`463a39f`](https://github.com/knpkv/npm/commit/463a39fac06cd41205b4733ccce9a1649c852093)]:
  - @knpkv/herdr-connect@0.20.0

## 0.33.0

### Minor Changes

- [#852](https://github.com/knpkv/npm/pull/852) [`fd8fb68`](https://github.com/knpkv/npm/commit/fd8fb68c95cbb05ef206bf8e92683cc5f4023a71) Thanks [@konopkov](https://github.com/konopkov)! - Add stage notification controls for per-agent mutes and quiet hours in the user's time zone. Keep the last saved settings after failed changes and link devices with notifications off to Approvals. Let applications supply stage controls through the optional `ConnectSurface.stageFooter` prop. Render the muted notification status as one sentence matching the design.

  Replace full-snapshot `PUT /v1/push/blocked-settings` with atomic `PATCH` intents for one agent's mute or quiet hours, so a stale device cannot overwrite another device's preferences. Queue mute toggles and quiet-hour reversions against their latest intended values. Enter after a queued Clear saves the visible time pair as the final intent without duplicate saves. Save valid drafts on backdrop and Close dismissal while keeping Escape as cancel. Preserve keyboard focus while editing times, and show devices with stale subscription keys as off until Approvals reconciles them.

### Patch Changes

- Updated dependencies [[`fd8fb68`](https://github.com/knpkv/npm/commit/fd8fb68c95cbb05ef206bf8e92683cc5f4023a71)]:
  - @knpkv/herdr-connect@0.19.0

## 0.32.0

### Minor Changes

- [#858](https://github.com/knpkv/npm/pull/858) [`75cbd22`](https://github.com/knpkv/npm/commit/75cbd223d797c52021b0d13b0ef30b568379b289) Thanks [@konopkov](https://github.com/konopkov)! - Add optional configured `hosts` to fleet directory responses and `configuredHosts` to the directory view. Empty directories keep search and filters, and name configured hosts when supplied by the hub. Older responses remain supported without the hint.

  Remember missing parents' display names through optional relationship `parentName` and archive name lookup, without treating those names as live identity. Keep a lone orphan's alert inline, while siblings share one missing-parent notice. Retain typed unavailable readings in `ConnectLimitsView.problems` for limits warnings.

  Keep live directory rows available when archive name enrichment fails, with a warning in the server log. Keep disabled limits hidden after refresh failures, and identify an unavailable host when other host readings are present.

  Match directory recovery, empty filters, orphan groups and pinned agents to the current design. Use commas in directory copy, 48px HTTP recovery and clear-search controls, compact timeout and scoped filter controls with 44px hit areas, and sticky pins with reserved footer space that leaves agent rows and footer actions clear. Cap phone pin pills at 144px and truncate only names, keeping state words visible with 12px end padding. Give directory reads a typed ten-second deadline and distinguish actual timeouts from HTTP, network and decoding failures; omit the Usage link for a generic limits request failure. Match secondary metadata, regular body text and inset family dividers. Keep the limits footer hidden until the first directory loads, while preserving it with retained stale rows.

### Patch Changes

- Updated dependencies [[`75cbd22`](https://github.com/knpkv/npm/commit/75cbd223d797c52021b0d13b0ef30b568379b289)]:
  - @knpkv/herdr-connect@0.18.0

## 0.31.0

### Minor Changes

- [#859](https://github.com/knpkv/npm/pull/859) [`820b6b7`](https://github.com/knpkv/npm/commit/820b6b7c6dfbb7a6e4b25978233ec80d981ec7a5) Thanks [@konopkov](https://github.com/konopkov)! - Add agent-authored creature self-state to the authenticated directory, backed by the shared post database with partial updates, archive cleanup and rate limits. Add host-authorized relay me and the stdio relay_me MCP tool with shared current-pane resolution and transport.

### Patch Changes

- Updated dependencies [[`820b6b7`](https://github.com/knpkv/npm/commit/820b6b7c6dfbb7a6e4b25978233ec80d981ec7a5)]:
  - @knpkv/herdr-connect@0.17.0

## 0.30.0

### Minor Changes

- [#854](https://github.com/knpkv/npm/pull/854) [`3901a04`](https://github.com/knpkv/npm/commit/3901a04c94cc07c5a32416abeb96cf09a780cfd8) Thanks [@konopkov](https://github.com/konopkov)! - Replace the shell Chef mark, favicon and install icons with the approved M2 Flat-plus drawing. Keep the single Ask Relay launcher, its existing sizes and open styling, and the conversation creatures. Use pixel-specific phone/desktop drawings and instance-local clip paths, including forced colours.

## 0.29.1

### Patch Changes

- Updated dependencies [[`5db8146`](https://github.com/knpkv/npm/commit/5db8146fa812d17d2c2c630cde641be5d654bdac)]:
  - @knpkv/browser-pairing@0.8.0
  - @knpkv/codecommit-web@0.35.1

## 0.29.0

### Minor Changes

- [#846](https://github.com/knpkv/npm/pull/846) [`f47bcd8`](https://github.com/knpkv/npm/commit/f47bcd8cb0ff789a068cd6ad1eefb912f28a1f89) Thanks [@konopkov](https://github.com/konopkov)! - Use the approved static Chef logo in the module shell, with square 32px desktop and 24px phone marks. The existing expanded styling indicates whether Ask Relay is open; status announcements and the conversation's Creature poses retain their behavior. Legacy Fleet and dashboard marks remain unchanged. `HubRelay.launcherMark` defaults to `creature`; `chef` explicitly selects the static logo independently of launcher labels.

  Update the app, maskable and notification icons, and serve a separate simplified favicon. Installed app identity and legacy icon URLs remain stable. Committed icon hashes and drawing parity guards verify the approved geometry.

## 0.28.0

### Minor Changes

- [#843](https://github.com/knpkv/npm/pull/843) [`929ef05`](https://github.com/knpkv/npm/commit/929ef055945cffcdb9d78fc2708ee1871c1126e3) Thanks [@konopkov](https://github.com/konopkov)! - Derive the machine-local Code owner link from the current private control file instead of a fixed port.
  Code queue/status responses gain optional validated `ownerUi` metadata; the host server entry exports
  its origin-only reader. Missing or invalid metadata has no fallback and exposes no control credential.

  Point unreadable-cache guidance to the owner service and hub log, and document owner-only cache
  migration and the native SQLite deployment probe. Strengthen the selection-close browser guard to
  exercise a visible, enabled, hit-testable Close button without forced pointer input.

### Patch Changes

- Updated dependencies [[`929ef05`](https://github.com/knpkv/npm/commit/929ef055945cffcdb9d78fc2708ee1871c1126e3), [`929ef05`](https://github.com/knpkv/npm/commit/929ef055945cffcdb9d78fc2708ee1871c1126e3)]:
  - @knpkv/codecommit-web@0.35.0
  - @knpkv/browser-pairing@0.7.0

## 0.27.1

### Patch Changes

- Updated dependencies [[`d9b889e`](https://github.com/knpkv/npm/commit/d9b889e13690c701f94448d831efbc0ae875624f)]:
  - @knpkv/browser-pairing@0.6.0
  - @knpkv/codecommit-web@0.34.1

## 0.27.0

### Minor Changes

- [#833](https://github.com/knpkv/npm/pull/833) [`56d9856`](https://github.com/knpkv/npm/commit/56d98569cf3c758a4e69f1331dc9048335192a26) Thanks [@konopkov](https://github.com/konopkov)! - Fix notification taps by navigating a controlled same-origin window, then focusing the returned client. Failed navigation opens the deep link with the click's remaining window-interaction grant. Preserve a bounded optional Voice blocker event ID in the push payload and stage URL. Connect opens the agent stage now; scrolling to the post waits for the posts view. Approval deep links keep their existing targets.

- [#839](https://github.com/knpkv/npm/pull/839) [`012b752`](https://github.com/knpkv/npm/commit/012b752f033598df7d129f72bac3f3fcea36691c) Thanks [@konopkov](https://github.com/konopkov)! - Running `relay` without a subcommand opens the configured Relay UI when the tailnet hub answers. When it is unreachable, the command reports the local dashboard URL or that hostd is not running, without opening a browser or starting hostd.

- [#834](https://github.com/knpkv/npm/pull/834) [`884a08c`](https://github.com/knpkv/npm/commit/884a08ca0583b2c9f4e5e7e189f0cb893d6aa083) Thanks [@konopkov](https://github.com/konopkov)! - Add `ModulePageMount.closeSelection(parentHref)` for targets opened through shell navigation. Code Close and Escape return through Back when the current shell opened the target from that exact parent; direct, reloaded or remounted targets close with replace instead. Other module-mount hosts must supply the new method.

  Preserve foreign history-state keys and selection origin through query repairs. Closing dialogs retain focus ownership after cleanup, and Forward reopens the target without adding duplicate queue entries.

### Patch Changes

- Updated dependencies [[`a8e6ea2`](https://github.com/knpkv/npm/commit/a8e6ea23653950ac8d1c9b6e6bca337506f4972f)]:
  - @knpkv/codecommit-web@0.34.0

## 0.26.0

### Minor Changes

- [#821](https://github.com/knpkv/npm/pull/821) [`9ffdbef`](https://github.com/knpkv/npm/commit/9ffdbef7fe8493d241580043cb5cad4521174423) Thanks [@konopkov](https://github.com/konopkov)! - Notify subscribed users when agents need attention, with durable episode deduplication, one reminder, visible-stage acknowledgement, per-agent mute and quiet hours in a validated IANA time zone. Add application-owned stage observation and a pure shared state-bucket helper to Connect.

- [#828](https://github.com/knpkv/npm/pull/828) [`4d9887b`](https://github.com/knpkv/npm/commit/4d9887baa4cc085bbba5f2c2ece864f1b33cc938) Thanks [@konopkov](https://github.com/konopkov)! - A failed `nix.check` or `nix.apply` now reports the tail of its stdout after its stderr, so an error a tool writes to stdout (such as `brew bundle`'s) is no longer lost. Parsed commands' failures are unchanged.

- [#831](https://github.com/knpkv/npm/pull/831) [`a530ddf`](https://github.com/knpkv/npm/commit/a530ddffe40953328aa6e216d42e66a836ffd681) Thanks [@konopkov](https://github.com/konopkov)! - Add host-local, read-only Code contracts and saved-grant provider authority with mandatory
  authenticated-caller audit before execution. Existing owner prompts and provider writes retain
  their pairing and CSRF protection. Code content never enters peer/fleet aggregation or hub Relay.

  Core adds fresh saved-permission checks, an existing-only private database verifier and a bounded
  cache read/audit attachment that refuses unknown schemas without migration or permission repair.
  The Code host factory reuses one provider and retries failed scoped attachments after two seconds.

  Hub adds explicit credential-host configuration and read-only Code routes. Route callbacks receive
  the decoded ModuleCaller; dispatch authorization now returns that typed caller rather than an
  unknown value. Consumers must update authorization effects to return the authenticated login.

  Code adds a controlled CodeHostView through the browser-safe views entry and a separate host
  stylesheet. The hub mounts its queue, cached approvals and immutable diff pages with active-only
  abortable reads, opaque target selectors and explicit unavailable states. ModuleViews accepts an
  optional decorative navigationIcon; its absence retains the shell's default glyph.

  The controlled Code view optionally delegates deliberate target navigation to its host while
  modified anchors retain browser behavior. Immutable diff readings include their read time and
  cached source timestamp; a changed cached PR warns that a retained diff may be outdated without
  initiating another provider read.

  The workspace views type entry uses built declarations to isolate owner source aliases. Build Code
  web before checking hub consumers. Build and prepack force declaration emission after output cleanup;
  published views types, runtime and stylesheet paths remain unchanged.

### Patch Changes

- [#830](https://github.com/knpkv/npm/pull/830) [`96bd47e`](https://github.com/knpkv/npm/commit/96bd47eb282ec5b9321e980f693574406072d41d) Thanks [@konopkov](https://github.com/konopkov)! - Keep local blocked notifications available when peer discovery fails, deliver to up to four subscriptions concurrently while preserving each subscription's episode order, and avoid repeated stage reports when an inline callback changes identity.

- [#832](https://github.com/knpkv/npm/pull/832) [`9561de3`](https://github.com/knpkv/npm/commit/9561de3bcdc8cf21598087700dc742993d143cda) Thanks [@konopkov](https://github.com/konopkov)! - Report the text field, actual length and kind-specific limit when Relay posts are too long. CLI and HTTP validation share the same errors and reject empty or whitespace-only text while accepting URLs within the limit.

  Export shared Connect post text limits and reject blank text only in the published posting schemas. Historical whitespace-only reports and last words stay readable. Hub validation uses the published schemas as its authority.

- Updated dependencies [[`9ffdbef`](https://github.com/knpkv/npm/commit/9ffdbef7fe8493d241580043cb5cad4521174423), [`96bd47e`](https://github.com/knpkv/npm/commit/96bd47eb282ec5b9321e980f693574406072d41d), [`9561de3`](https://github.com/knpkv/npm/commit/9561de3bcdc8cf21598087700dc742993d143cda), [`1f5333d`](https://github.com/knpkv/npm/commit/1f5333d6b0aafb0baa5375c7659d7b26f1a3f180), [`a530ddf`](https://github.com/knpkv/npm/commit/a530ddffe40953328aa6e216d42e66a836ffd681)]:
  - @knpkv/herdr-connect@0.16.0
  - @knpkv/codecommit-web@0.33.0

## 0.25.0

### Minor Changes

- [#822](https://github.com/knpkv/npm/pull/822) [`c7fa96b`](https://github.com/knpkv/npm/commit/c7fa96be781457406e8de323bffdd9e137e66127) Thanks [@konopkov](https://github.com/konopkov)! - `nix.check` and `nix.apply` no longer stop the command when its output passes 128 KiB. The cap used to fail the job and terminate the command's process group mid-run, which could leave an activation half applied. These commands now run to completion, their exit code alone decides the job, and each stream keeps its last 64 KiB after an `[N earlier bytes omitted]` line. Output that is parsed still fails past 128 KiB.

- [#820](https://github.com/knpkv/npm/pull/820) [`9d43b5e`](https://github.com/knpkv/npm/commit/9d43b5e17d6773a0b93530abc45992b0c87597e7) Thanks [@konopkov](https://github.com/konopkov)! - Export the `relay` CLI as `@knpkv/herdr-hub/relay`, so a host that bundles its executables (as it bundles `@knpkv/herdr-hub/fleetctl`) can ship `relay` too.

### Patch Changes

- Updated dependencies [[`c7fa96b`](https://github.com/knpkv/npm/commit/c7fa96be781457406e8de323bffdd9e137e66127), [`0fa3c3a`](https://github.com/knpkv/npm/commit/0fa3c3a81a4f1b30c43091f82a8ecdd68ddbfcd0)]:
  - @knpkv/bounded-io@0.3.0
  - @knpkv/rly@0.22.1
  - @knpkv/herdr-connect@0.15.1
  - @knpkv/herdr-fleet@0.10.1
  - @knpkv/herdr-tailscale@0.3.2

## 0.24.0

### Minor Changes

- [#808](https://github.com/knpkv/npm/pull/808) [`f5e574a`](https://github.com/knpkv/npm/commit/f5e574abb9dec49f205caeefad3d89400cdd9a0e) Thanks [@konopkov](https://github.com/konopkov)! - Register a read-only Usage details module with typed range, time-zone and host selectors. Keep legacy Fleet Usage destinations intact and reuse the hub's existing usage and limits reports.

  SuperappShell accepts an optional typed mobileModules list for the phone bar, with off-bar modules announced on All modules. ModulePageMount.navigate accepts an optional focus destination. Page focus remains the default; null keeps focus on an in-page selector while its URL is replaced.

  Expose the existing stateless UsageTab, browser report loaders, view-state helpers, loopback helpers and report/query types through herdr-connect's browser-safe usage entry. UsageTab's optional presentation selects Limits or Tokens beneath a host-supplied heading; its default Fleet markup and existing UsageSurface behaviour are unchanged. Reports carry no cost, balances, bookings, sessions, paths or prompt prefixes.

### Patch Changes

- Updated dependencies [[`f5e574a`](https://github.com/knpkv/npm/commit/f5e574abb9dec49f205caeefad3d89400cdd9a0e)]:
  - @knpkv/herdr-connect@0.15.0

## 0.23.0

### Minor Changes

- [#803](https://github.com/knpkv/npm/pull/803) [`0dfab65`](https://github.com/knpkv/npm/commit/0dfab650505c01d94184831b34aa99cc5c957ce3) Thanks [@konopkov](https://github.com/konopkov)! - Add bounded agent voice posts on the authenticated canonical hub, with host-bound live inventory checks, idempotent retries, paged retention, and archived last words. Add the relay post CLI.

### Patch Changes

- Updated dependencies [[`0dfab65`](https://github.com/knpkv/npm/commit/0dfab650505c01d94184831b34aa99cc5c957ce3), [`3c5bfb7`](https://github.com/knpkv/npm/commit/3c5bfb7fee6e8fb14fe64a28688be752a5cb60b9), [`3865413`](https://github.com/knpkv/npm/commit/3865413011482749e76c23bf8e1066b63b6ed5b8)]:
  - @knpkv/herdr-connect@0.14.0
  - @knpkv/rly@0.22.0
  - @knpkv/herdr-work@0.12.1
  - @knpkv/relay-product@0.6.1

## 0.22.0

### Minor Changes

- [#798](https://github.com/knpkv/npm/pull/798) [`a528984`](https://github.com/knpkv/npm/commit/a528984f1ee6351ef0ec83b16d47e88096d5d239) Thanks [@konopkov](https://github.com/konopkov)! - Open the canonical hub on Today, with one server-collected needs-you list, exact Fleet approval links and the existing agent/history snapshots. Discovery is Fleet-only initially. Failed and partial reads remain visible; polling stops when Today is inactive or the document is hidden. Room to work links to the existing Fleet Usage view.

  Add browser-safe needs-you schemas, the Today descriptor and view, an optional closed provider effect on ModuleHandlers, and product layers on HttpServerOptions. The hub owns collection and the reserved Today read route, bounds each provider, validates destinations, deduplicates rows and issues no approval proofs.

  Require query codecs for module read and write routes. Handlers receive validated selectors; invalid or excess selectors fail before the handler runs. Existing route constructors must supply the new query argument. ModuleListener and product descriptors now exclude the Work peer listener, which retains its restricted existing API.

## 0.21.0

### Minor Changes

- [#789](https://github.com/knpkv/npm/pull/789) [`bdabf68`](https://github.com/knpkv/npm/commit/bdabf6855cf008d5b08ca00de775895cbed0fcaa) Thanks [@konopkov](https://github.com/konopkov)! - Approvals show the requesting bot's Connect portrait when its exact identity is known, retain requests after failed reads, and revalidate stale decisions before sending them. The Connect surface exports AgentCreature for shared requester portraits.

  The request list and history follow the responsive Approvals layout. Full request disclosures can show JSON built from the same normalized fields as the default field view.

- [#790](https://github.com/knpkv/npm/pull/790) [`57880bb`](https://github.com/knpkv/npm/commit/57880bbfb042d60bfed8a4465260e8b47c7e25c4) Thanks [@konopkov](https://github.com/konopkov)! - Add `WorkService.attachPullRequest` and `fleetctl work attach-pr` to attach a GitHub pull request to an existing goal. The latest event, stored repository and branch, active state, and existing review URL are checked in the same transaction that derives and appends the checkpoint. Concurrent goal changes produce `WorkPullRequestAttachConflict` instead of being overwritten. Reattaching the same URL is a no-op success that preserves later goal updates.

- [#793](https://github.com/knpkv/npm/pull/793) [`4286d6b`](https://github.com/knpkv/npm/commit/4286d6b23fd9a0bbbca9bc15e06a8d641828ef32) Thanks [@konopkov](https://github.com/konopkov)! - Prevent a queued decision on a stale read from being sent after the request changed or left the pending queue. Keep refreshed pending pages and deep-link lookup results tied to their source snapshot before verifying a decision.

- [#791](https://github.com/knpkv/npm/pull/791) [`70f28c7`](https://github.com/knpkv/npm/commit/70f28c782bc8621513b9255e245533a7baa5d710) Thanks [@konopkov](https://github.com/konopkov)! - Mount the canonical hub in the Relay module shell with shared navigation, notifications and one conversation. Preserve Fleet deep links and approval state across module changes.

  Allow the shared Relay launcher to use separate desktop and phone labels.

  Use the current navigation selection in WorkBoard without remounting focused controls.

  Add decorative avatar slots to Relay's launcher, panel and transcript, forwarded by the conversation panel. The hub supplies its shared character with typed phases and composer-focus tracking.

  Retain the Dialog portal layer until its exit motion completes.

  Allow Dialog hosts to restore a navigation destination after modal cleanup, with opener restoration as the default.

  Dialog now returns focus to the opener after its exit and modal cleanup instead of immediately on close; downstream tests must wait for cleanup.

### Patch Changes

- Updated dependencies [[`bdabf68`](https://github.com/knpkv/npm/commit/bdabf6855cf008d5b08ca00de775895cbed0fcaa), [`57880bb`](https://github.com/knpkv/npm/commit/57880bbfb042d60bfed8a4465260e8b47c7e25c4), [`70f28c7`](https://github.com/knpkv/npm/commit/70f28c782bc8621513b9255e245533a7baa5d710)]:
  - @knpkv/herdr-connect@0.13.0
  - @knpkv/herdr-work@0.12.0
  - @knpkv/rly@0.21.0
  - @knpkv/relay-product@0.6.0
  - @knpkv/herdr-coordinator@0.4.1

## 0.20.0

### Minor Changes

- [#764](https://github.com/knpkv/npm/pull/764) [`b08f713`](https://github.com/knpkv/npm/commit/b08f713a08f44c11a0f90528996faf162e7a96c6) Thanks [@konopkov](https://github.com/konopkov)! - Retain compact closed-agent records after two complete host reads confirm at least five minutes of absence. Expose bounded archive pages through the authenticated hub listener and remove records when the same agent returns. Older peers remain visible but supply no closure evidence until they report complete inventories. Failed writes restart that host's closure grace period after recovery; restarting the store requires fresh absence evidence and retains existing archive records.

- [#787](https://github.com/knpkv/npm/pull/787) [`3ba4e78`](https://github.com/knpkv/npm/commit/3ba4e78663b026f101f929ef41294a48b6bafc5a) Thanks [@konopkov](https://github.com/konopkov)! - Check explicit durable operation rejection before settling an unaccepted Fleet job, including on restart recovery. Store bounded cause-tagged errors for definitively uncommitted failures while preserving recovery for uncertain outcomes and accepted receipts.

  Validate optional delegate `newWork` branches and goal titles, bind both fields into the approval hash, and show the proposed goal in approvals, the dashboard, and fleetctl output so approval covers the goal that delegation will create. Failed job and follow output retain the operation error.

  Keep credential-redacted Unicode titles decodable at the length boundary, and escape terminal controls in shared fleetctl job, follow, and pending-submit output so untrusted fields cannot alter terminal presentation.

- [#772](https://github.com/knpkv/npm/pull/772) [`a947727`](https://github.com/knpkv/npm/commit/a9477277535a0543caf5d70babc41acda60ee315) Thanks [@konopkov](https://github.com/konopkov)! - Add a browser-safe views entry for the hub UI.

- [#765](https://github.com/knpkv/npm/pull/765) [`bd86c66`](https://github.com/knpkv/npm/commit/bd86c6696678b8c5469727d646096381406f1179) Thanks [@konopkov](https://github.com/konopkov)! - Show goal delivery steps and observed checks and review with their read time in the Work inspector. Group the board as plain rows, keep phone status filters on one scrolling line, and distinguish retained finished goals from response and retention omissions. The hub supplies its own host to the board header.

- [#771](https://github.com/knpkv/npm/pull/771) [`27bd371`](https://github.com/knpkv/npm/commit/27bd3714a526256705da5147872a0e7b68dae8c5) Thanks [@konopkov](https://github.com/konopkov)! - Expose the dashboard, activity, approval, refresh, and conversation UI through the public API.
  Expose the character, agent stage, pinned agents, limits, and usage UI through the public API.

- [#776](https://github.com/knpkv/npm/pull/776) [`4bd33fa`](https://github.com/knpkv/npm/commit/4bd33fa1acb480976631f33267ed68b1299b78fa) Thanks [@konopkov](https://github.com/konopkov)! - Add browser-safe Relay module descriptors and hash navigation, with a separate Effect server registration and authenticated route dispatcher. Preserve legacy Fleet tab links and their object-selection parameters when canonicalizing URLs.

### Patch Changes

- [#766](https://github.com/knpkv/npm/pull/766) [`6644cb7`](https://github.com/knpkv/npm/commit/6644cb74218d7daf7f618f1da69dc30e4aa3d93a) Thanks [@konopkov](https://github.com/konopkov)! - A decided request reads at a glance. `DecisionBar` takes an optional `outcome` (label, tone, icon) that leads its status line as a toned word, with `status` as the quiet who-and-when line beside it. The status region stays the same element, so the answer is still announced, and an `off` reason the outcome already says is kept only as the inert actions' description. The hub's approvals bar uses it: Approved (positive, check), Rejected (critical, close), Expired (neutral, clock: nothing happened). Activity history now shows expired as neutral with a clock too, so the hub says it one way.

- [#762](https://github.com/knpkv/npm/pull/762) [`29c8bc1`](https://github.com/knpkv/npm/commit/29c8bc1212de8592f30462a0e86280a05afcf27b) Thanks [@konopkov](https://github.com/konopkov)! - Connect in the hub uses a phone's full width. On screens up to 40rem the hub shell keeps one 16px gutter instead of 32px, and the embedded Connect panel adds none of its own, so an agent's row spans the screen less 32px. The Status options keep to one line whatever their counts, scrolling sideways rather than wrapping; host names still wrap so a long one stays readable.

- [#757](https://github.com/knpkv/npm/pull/757) [`77d046d`](https://github.com/knpkv/npm/commit/77d046da38d5bfec6f69d33cef1beb6e0948fe90) Thanks [@konopkov](https://github.com/konopkov)! - Refuse browser WebSocket upgrades on the tailnet terminal endpoint. Only the hub's own relay dials `/v1/connect/terminal`, and it sends no `Origin`; an upgrade carrying an `Origin` or a cross-site `Sec-Fetch-Site` is now rejected before the Tailscale identity check, so a web page open on the hub node cannot drive a peer's terminal.

- [#759](https://github.com/knpkv/npm/pull/759) [`8017b49`](https://github.com/knpkv/npm/commit/8017b490395ea15e3949b946ebe8f5313b5d165b) Thanks [@konopkov](https://github.com/konopkov)! - Restrict the unauthenticated Work-only listener to loopback. `workBindAddress` now accepts only `127.0.0.0/8` addresses, and the listener refuses Work snapshot and checkpoint requests from any non-loopback peer. Paired LAN access remains available through `lanWork`.
- Updated dependencies [[`b08f713`](https://github.com/knpkv/npm/commit/b08f713a08f44c11a0f90528996faf162e7a96c6), [`241c5c7`](https://github.com/knpkv/npm/commit/241c5c7af802fb427fca1ac4e40a86151b8527f0), [`20cb874`](https://github.com/knpkv/npm/commit/20cb8746e9b9519b3a0dc371ec654c79a874df95), [`05281e2`](https://github.com/knpkv/npm/commit/05281e2b90cd59c4373cb6e5aa79dcb8242c49a9), [`138d1e6`](https://github.com/knpkv/npm/commit/138d1e6b9aaab4f4e50965a113f87c202c113d1a), [`6644cb7`](https://github.com/knpkv/npm/commit/6644cb74218d7daf7f618f1da69dc30e4aa3d93a), [`4ebe301`](https://github.com/knpkv/npm/commit/4ebe30154220bff53ec507a0d70c5f8f4a543c5a), [`3ba4e78`](https://github.com/knpkv/npm/commit/3ba4e78663b026f101f929ef41294a48b6bafc5a), [`a947727`](https://github.com/knpkv/npm/commit/a9477277535a0543caf5d70babc41acda60ee315), [`29c8bc1`](https://github.com/knpkv/npm/commit/29c8bc1212de8592f30462a0e86280a05afcf27b), [`bd86c66`](https://github.com/knpkv/npm/commit/bd86c6696678b8c5469727d646096381406f1179), [`27bd371`](https://github.com/knpkv/npm/commit/27bd3714a526256705da5147872a0e7b68dae8c5), [`09eb563`](https://github.com/knpkv/npm/commit/09eb56339ed68e9ac6c420947e9f617c4aa6a36d), [`5013de5`](https://github.com/knpkv/npm/commit/5013de5bee7f341bc11d86ef3194eb8a37912777), [`8017b49`](https://github.com/knpkv/npm/commit/8017b490395ea15e3949b946ebe8f5313b5d165b)]:
  - @knpkv/herdr-connect@0.12.0
  - @knpkv/herdr-coordinator@0.4.0
  - @knpkv/rly@0.20.0
  - @knpkv/relay@0.2.2
  - @knpkv/herdr-fleet@0.10.0
  - @knpkv/herdr-work@0.11.0
  - @knpkv/relay-product@0.5.2

## 0.19.0

### Minor Changes

- [#750](https://github.com/knpkv/npm/pull/750) [`1e3fa2c`](https://github.com/knpkv/npm/commit/1e3fa2c7edc1b33f5a870fc63e7e0e00b7724436) Thanks [@konopkov](https://github.com/konopkov)! - `@knpkv/herdr-approvals` is now `@knpkv/herdr-hub`: the package serves the whole hub (Approvals, Connect, Work, Usage and Relay), not approvals alone. The `hostd` and `fleetctl` binaries and every export path (`.`, `./fleetctl`, `./hostd`, `./hostd-runtime`) are unchanged; install `@knpkv/herdr-hub` in place of `@knpkv/herdr-approvals`, which is deprecated.

### Patch Changes

- Updated dependencies [[`928f3e2`](https://github.com/knpkv/npm/commit/928f3e2f70fc7dc3074502b0558f55b178ce475f), [`99cf00e`](https://github.com/knpkv/npm/commit/99cf00e9738d3c617ad6c95dc5076ca18767f77e)]:
  - @knpkv/herdr-connect@0.11.1

## 0.18.0 (@knpkv/herdr-approvals)

### Minor Changes

- [#743](https://github.com/knpkv/npm/pull/743) [`646b0f0`](https://github.com/knpkv/npm/commit/646b0f0aa3082cbdfe916e9c9ba22de2882cbc3a) Thanks [@konopkov](https://github.com/konopkov)! - The hub's masthead mark is now Relay's launcher. It shows what Relay is doing and opens the fleet conversation in rly's panel with a click or Ctrl/⌘+J (left to the terminal while Connect shows). Relay's status is announced only while the panel is closed. `get_work_board` says that goals finished more than a day ago are not counted.

### Patch Changes

- [#747](https://github.com/knpkv/npm/pull/747) [`375d10f`](https://github.com/knpkv/npm/commit/375d10fcd34d3b2a3e411251a4acfb314f01ce2a) Thanks [@konopkov](https://github.com/konopkov)! - The closed Relay launcher announces each run once, when it starts (including the run a queued message starts), instead of at every tool boundary as its words change between "Reading…", "Answering…" and "Working…". The words beside the mark still follow the run.

- [#746](https://github.com/knpkv/npm/pull/746) [`8a3fec2`](https://github.com/knpkv/npm/commit/8a3fec2e72fda7e61c4fbc8d4e9f83ec48e75fd2) Thanks [@konopkov](https://github.com/konopkov)! - Republish: npm left 0.17.0 staged and never made it visible, so this release carries the same code.
- Updated dependencies [[`646b0f0`](https://github.com/knpkv/npm/commit/646b0f0aa3082cbdfe916e9c9ba22de2882cbc3a), [`646b0f0`](https://github.com/knpkv/npm/commit/646b0f0aa3082cbdfe916e9c9ba22de2882cbc3a)]:
  - @knpkv/relay-product@0.5.1
  - @knpkv/relay@0.2.1

## 0.17.0 (@knpkv/herdr-approvals)

### Minor Changes

- [#718](https://github.com/knpkv/npm/pull/718) [`58dca5f`](https://github.com/knpkv/npm/commit/58dca5f56a7870ca059538e8a96209192fb3de9c) Thanks [@konopkov](https://github.com/konopkov)! - The hub serves usage history for the Usage tab. hostd answers `GET /v1/connect/usage?range=24h|7d|30d&timeZone=<zone>` with each host's `agent-usage usage` read, which holds tokens per period, agent and model, and the limit series. It derives that command from the existing `agentUsageLimitsCommand`. On the hub the answer includes every peer's read, from the peer's tailnet `/v1/connect/usage/local`. A bad range or zone is refused with 400 before anything runs, and reads are cached per range and zone for five minutes. herdr-connect exports the `FleetUsage` schemas, a tolerant decoder that skips token cells and limit series from a newer agent-usage and counts them, and `hubUsage`/`fleetUsage`. Limits and usage now share one fan-out helper.

  A host that cannot read its limits or usage now reports one of a fixed set of sentences ("agent-usage is not running on this host", "older version", "control socket could not be used"). agent-usage's stderr and spawn errors can name host paths, so they are logged on the host and no longer sent across the tailnet. This fixes the same leak in limits, present since [#698](https://github.com/knpkv/npm/issues/698). The hub waits 25 seconds for a peer's usage, longer than a cold 30-day read. Concurrent first asks for a range and zone share one read, and at most two reads run at once.

- [#722](https://github.com/knpkv/npm/pull/722) [`202ec0d`](https://github.com/knpkv/npm/commit/202ec0d1161718d8cb0974c50194241097aab88a) Thanks [@konopkov](https://github.com/konopkov)! - The hub has a Usage tab beside Approvals, Connect and Work (`g` then `u`, `?tab=usage`). It shows each host's "Limits now" cards, the fleet's tokens per day or hour stacked by agent and model, and each host's limits over the range, with a 24h/7d/30d switch on every screen size that defaults to 7 days and is remembered in the browser. On the hub's own machine it links to agent-usage's full page. Connect keeps its one-line limits strip, which now links to the Usage tab instead of opening the per-host cards. herdr-connect exports the tab as `@knpkv/herdr-connect/usage` (`UsageSurface`, `makeUsageAtoms`). The hub now passes on a peer's unavailable detail only when it is one of hostd's fixed sentences, so an older peer cannot relay raw agent-usage stderr through it.

- [#725](https://github.com/knpkv/npm/pull/725) [`94056da`](https://github.com/knpkv/npm/commit/94056da6f621030ee1dfeaeb7d72f02ba583079b) Thanks [@konopkov](https://github.com/konopkov)! - hostd no longer fails to start when an install lacks the Relay PNG icons. It reads each icon when a browser asks for it and answers 404 when the file is missing, so the manifest's SVG icon covers it. Installing the icon later needs no restart.

  Breaking for code that builds its own `UiAssets` for `startHttpServer`: the `icons` map is replaced by `icon(file)`, which returns a promise of the PNG's bytes, or `null` when the file is unknown or missing.

- [#735](https://github.com/knpkv/npm/pull/735) [`323e894`](https://github.com/knpkv/npm/commit/323e8948ac2a383200f55c4a606a70031dd5f8b4) Thanks [@konopkov](https://github.com/konopkov)! - The hub mounts Relay, read-only. The canonical listener serves `/v1/relay/*` for one fleet conversation, checking identity, origin and the conversation before Relay starts. Relay reads the fleet's agents, the pending approvals, one job's state and the work board, each answer capped in items and bytes, and cannot approve, decline, prompt or submit. hostd loads Relay on the first request, so a broken install or a store another hostd holds answers 503 with the fix and never stops the hub; the next request retries. Sessions live in `<stateDirectory>/relay/sessions.sqlite`. New server option: `relay: { directory, backends? }`.

- [#737](https://github.com/knpkv/npm/pull/737) [`6fddeab`](https://github.com/knpkv/npm/commit/6fddeab63340c81223691a3a1e96f53e2dbabcd1) Thanks [@konopkov](https://github.com/konopkov)! - A large Work board never hides goals silently. The Work tab says "N older goals not shown" for a window the board cut, and `fleetctl work snapshot` prints the same per window on stderr, keeping stdout the snapshot alone. Snapshots now carry `version: 1`. Readers accept any version and ignore keys they don't know; when a newer format no longer decodes, fleetctl says "upgrade fleetctl with the hub" and the hub page says "reload the page" instead of reporting a malformed snapshot. A fleetctl from before this release still decodes strictly and fails against a hub that cut its board, so upgrade fleetctl with the hub; hosts updated together through nix are unaffected.

### Patch Changes

- [#733](https://github.com/knpkv/npm/pull/733) [`e7b8f1a`](https://github.com/knpkv/npm/commit/e7b8f1ab3d85fa47821246c4d034247150ab43ce) Thanks [@konopkov](https://github.com/konopkov)! - `fleetctl work snapshot` reads a newer hub's snapshot: keys it doesn't know are dropped instead of failing the read, and only the known shape is printed. Checkpoints sent to a hub are still decoded strictly.

- [#741](https://github.com/knpkv/npm/pull/741) [`c951532`](https://github.com/knpkv/npm/commit/c951532eef3faa2d756339060be2ce774f904c03) Thanks [@konopkov](https://github.com/konopkov)! - The Work board shows what needs triage. A finished goal leaves a window a day after it finished, counted in `finishedOmitted` ("N finished goals not shown"), and each goal carries its 8 most recent activities, with `activityOmitted` counting the rest ("8 most recent of N"). Stored history is unchanged. `fleetctl work snapshot` names finished goals left out on stderr, too.
- Updated dependencies [[`86b917c`](https://github.com/knpkv/npm/commit/86b917c379041a6b90a6834e33a1ea7fd9668900), [`2413daa`](https://github.com/knpkv/npm/commit/2413daaa479f20d1eceb3388213549f3fbc7628c), [`f2da944`](https://github.com/knpkv/npm/commit/f2da944253cfce068e2746324700f1ba68a2f047), [`e31ec38`](https://github.com/knpkv/npm/commit/e31ec38d3547fd92b977f630e7e048a473393b22), [`58dca5f`](https://github.com/knpkv/npm/commit/58dca5f56a7870ca059538e8a96209192fb3de9c), [`202ec0d`](https://github.com/knpkv/npm/commit/202ec0d1161718d8cb0974c50194241097aab88a), [`e7b8f1a`](https://github.com/knpkv/npm/commit/e7b8f1ab3d85fa47821246c4d034247150ab43ce), [`0728c72`](https://github.com/knpkv/npm/commit/0728c72870f6c648626da0493cc00d8c65c47d60), [`f925ee2`](https://github.com/knpkv/npm/commit/f925ee27ba3689acb941187cce4ee808301f5f95), [`94d8fdd`](https://github.com/knpkv/npm/commit/94d8fdd38022e2aa68f8bf4dd87924a542e9a7ea), [`ea0c0ed`](https://github.com/knpkv/npm/commit/ea0c0ed700cb69dd86e56fba425dd16d9869a577), [`c951532`](https://github.com/knpkv/npm/commit/c951532eef3faa2d756339060be2ce774f904c03), [`6fddeab`](https://github.com/knpkv/npm/commit/6fddeab63340c81223691a3a1e96f53e2dbabcd1)]:
  - @knpkv/herdr-connect@0.11.0
  - @knpkv/herdr-work@0.10.0
  - @knpkv/relay@0.2.0
  - @knpkv/rly@0.19.0
  - @knpkv/herdr-coordinator@0.3.9

## 0.16.0 (@knpkv/herdr-approvals)

### Minor Changes

- [#717](https://github.com/knpkv/npm/pull/717) [`8af4c75`](https://github.com/knpkv/npm/commit/8af4c7569dc195201e29dbf902b6bb221ec78f84) Thanks [@konopkov](https://github.com/konopkov)! - The hub is Relay: it installs as "Relay", its masthead and per-host header carry the Relay mark, its pages are titled "Relay", "Connect in Relay", "Work in Relay" and "{host} on Relay", and it serves PNG install, maskable, apple-touch and notification-badge icons drawn from rly's mark. Notifications use the new icon and a monochrome badge. Installed apps keep working: the manifest's `id`, `start_url` and `scope` are unchanged and the old icon path still answers.

### Patch Changes

- Updated dependencies [[`7267362`](https://github.com/knpkv/npm/commit/72673622a770d5b40c695fe13b36a82f80e78cf4), [`8af4c75`](https://github.com/knpkv/npm/commit/8af4c7569dc195201e29dbf902b6bb221ec78f84), [`eb2ddfd`](https://github.com/knpkv/npm/commit/eb2ddfd124b3e8805d886fa26c178aa59231f1b4)]:
  - @knpkv/rly@0.18.0
  - @knpkv/herdr-connect@0.10.2
  - @knpkv/herdr-work@0.9.5

## 0.15.0 (@knpkv/herdr-approvals)

### Minor Changes

- [#698](https://github.com/knpkv/npm/pull/698) [`586f75d`](https://github.com/knpkv/npm/commit/586f75d4b65e6d3c3b3f41f35d1b1a34facdb133) Thanks [@konopkov](https://github.com/konopkov)! - hostd serves Claude and Codex limits for Connect. Set the optional `agentUsageLimitsCommand` in the fleet configuration to `agent-usage limits`. `GET /v1/connect/limits` then returns this host's read, and on the hub every peer's read too. herdr-connect exports the wire schemas (`HostLimits`, `FleetLimits`) and the fleet collection. A host that can't read its limits says why instead of reporting zero.

### Patch Changes

- [#690](https://github.com/knpkv/npm/pull/690) [`7e38bea`](https://github.com/knpkv/npm/commit/7e38beabe14c07ec27adc9391f2a25d502e87491) Thanks [@konopkov](https://github.com/konopkov)! - Fleet connect no longer locks zoom on phones: pinch zoom works again, and the search field and the terminal's text input stay at 16px so focusing them doesn't zoom the page on iOS.

- [#666](https://github.com/knpkv/npm/pull/666) [`5b79b06`](https://github.com/knpkv/npm/commit/5b79b06f381232b284f77b3c533c334ede7782b3) Thanks [@konopkov](https://github.com/konopkov)! - Hub CSS follows good-css: hover highlights only on devices that hover, 44px touch targets for the nav and activity filters, a 16px activity search so iOS doesn't zoom, small-viewport heights, `overflow: clip`, and opt-in motion. The activity toolbar now sticks while the history scrolls.

- [#687](https://github.com/knpkv/npm/pull/687) [`ab6b732`](https://github.com/knpkv/npm/commit/ab6b7329bcc49337a658abaaf708fba2ce9ced44) Thanks [@konopkov](https://github.com/konopkov)! - Browser builds now target Chrome 123, Edge 123, Firefox 120 and Safari 17.6, the floor the CSS already relies on for `light-dark()` and `safe` alignment. Before, they targeted Vite's default (Chrome 111, Safari 16.4), so Lightning CSS rewrote `light-dark()` into its custom-property polyfill. Built CSS now keeps `light-dark()` native. For `@knpkv/rly` consumers, the published stylesheet assumes those browsers.
- Updated dependencies [[`7e38bea`](https://github.com/knpkv/npm/commit/7e38beabe14c07ec27adc9391f2a25d502e87491), [`fea24ef`](https://github.com/knpkv/npm/commit/fea24ef8e52da5918feb8a45ae314a6b670c0c6b), [`eee2128`](https://github.com/knpkv/npm/commit/eee21285ba0a8364cb47cc90ec5b1dd9bf2c8aab), [`586f75d`](https://github.com/knpkv/npm/commit/586f75d4b65e6d3c3b3f41f35d1b1a34facdb133), [`8f49d5b`](https://github.com/knpkv/npm/commit/8f49d5bafad19c7e3163538f7acb2f0f7de4d2d1), [`0848452`](https://github.com/knpkv/npm/commit/0848452bb7faecbf71c207648b430b895429da32), [`1cecd7c`](https://github.com/knpkv/npm/commit/1cecd7c454fdbdf042f7a3fd25a200805500881f), [`48830f8`](https://github.com/knpkv/npm/commit/48830f89057919d23ca408192cb68ac1893c8e96), [`799414f`](https://github.com/knpkv/npm/commit/799414f37422e7aeaf0a36bb80d8d878d75f5a10), [`2540508`](https://github.com/knpkv/npm/commit/2540508d00dc60c3842817df8ca37ce6c6a6179b), [`0848452`](https://github.com/knpkv/npm/commit/0848452bb7faecbf71c207648b430b895429da32), [`1902d84`](https://github.com/knpkv/npm/commit/1902d84417dc050cd7fe7a2472071275424f1e4f), [`ab6b732`](https://github.com/knpkv/npm/commit/ab6b7329bcc49337a658abaaf708fba2ce9ced44)]:
  - @knpkv/herdr-connect@0.10.0
  - @knpkv/herdr-fleet@0.9.0
  - @knpkv/rly@0.17.0
  - @knpkv/herdr-coordinator@0.3.8
  - @knpkv/herdr-work@0.9.4

## 0.14.0 (@knpkv/herdr-approvals)

### Minor Changes

- [#658](https://github.com/knpkv/npm/pull/658) [`504148b`](https://github.com/knpkv/npm/commit/504148b49fef69471bd3772c60d1629758ccf930) Thanks [@konopkov](https://github.com/konopkov)! - Connect is now the hub's one agent list, and the Work tab no longer repeats agents under Agent activity. Each Connect row leads with the agent's state (icon and word) in a fixed column, then its name and work, then when it was last active. Lineage indents the name, not the state. At 24rem and below the state sits above the name. A row's accessible name is its own content plus "open terminal". Status filter options show their counts within the current Host filter, ignoring the search. A host that didn't answer is named in the Host filter (not offered as an option) and, once, in a line above the list with its cause; the summary only counts agents: "GAMMA (timed out) didn't answer; its agents aren't listed." That line now shows on phones too. The directory shows when it was last read ("Updated 09:41:05"), changing only when a poll lands, and says "Stale" when a refresh failed. Empty and failure states read "No agents running on any host." and "The fleet directory didn't answer: …". `AgentDirectory` takes an optional `silentHosts`.

- [#660](https://github.com/knpkv/npm/pull/660) [`ba0d5ba`](https://github.com/knpkv/npm/commit/ba0d5ba68b20b947eb08892b0c94b63347eae78e) Thanks [@konopkov](https://github.com/konopkov)! - The host dashboard lists its agents in Connect's row shape and state language instead of a card grid. Its heading is "Agents on HOST". Each row shows the state (icon and word), the name, kind and work. An agent with a stable id gets an "Open on the hub" link to its terminal in the canonical hub's Connect. The decorative presence dot and the "N agents" chip are gone; the "Agents online" summary still counts the same list. Empty and failure states name their cause: "No agents running on HOST." and "Herdr isn't running on HOST: …. Start Herdr on HOST, then refresh."

### Patch Changes

- [#652](https://github.com/knpkv/npm/pull/652) [`2b79b24`](https://github.com/knpkv/npm/commit/2b79b241a95d5e6d54c1055e0b245bd24a490276) Thanks [@konopkov](https://github.com/konopkov)! - Connect's agents now speak the hub's state language. Each directory row shows the agent's state as an icon and word in its tone, the same label the hub's Agent activity uses, instead of a plain capitalised word. Only working agents spin, and only with motion allowed. `waiting` now counts under the Status filter's "Needs you" (renamed from "Attention") rather than "Ready", because it waits on a person. The work line no longer repeats the state ("Root agent, npm", not "Root agent, Working in npm"), since the label beside it says it. Unknown states keep their own word with a caution alert icon, so they never look idle. `@knpkv/herdr-connect/surface` exports `agentStatePresentation`, `AgentStateLabel`, `agentBuckets` and `agentBucketLabel`. herdr-approvals' Agent activity reads the same mapping, so its state words are now capitalised and blocked and errored agents show in critical tone.

- [#662](https://github.com/knpkv/npm/pull/662) [`991e71e`](https://github.com/knpkv/npm/commit/991e71e413973fb6083f8abf972fc0f66ac701bf) Thanks [@konopkov](https://github.com/konopkov)! - The host dashboard puts its "Needs attention" agenda above the agent rows, so whatever needs a decision comes before what is merely running.
- Updated dependencies [[`2b79b24`](https://github.com/knpkv/npm/commit/2b79b241a95d5e6d54c1055e0b245bd24a490276), [`504148b`](https://github.com/knpkv/npm/commit/504148b49fef69471bd3772c60d1629758ccf930), [`5199a49`](https://github.com/knpkv/npm/commit/5199a4959d643d029a9b7701bce94d904250abfd), [`8acdf0d`](https://github.com/knpkv/npm/commit/8acdf0dbd0800c27d5dd4d0130e035558f575975), [`69b015c`](https://github.com/knpkv/npm/commit/69b015cb21c15723688acff8a22515fdc4cd09d6), [`67f7ea1`](https://github.com/knpkv/npm/commit/67f7ea1a5e3c0281da1d627fce940975e2db0cf4), [`f5f5fd9`](https://github.com/knpkv/npm/commit/f5f5fd98dcea7b7df1b226043e89ffb6decaffad), [`ce3234a`](https://github.com/knpkv/npm/commit/ce3234a201e3336b17f22219c8215d11eecc3408), [`4a41bf8`](https://github.com/knpkv/npm/commit/4a41bf82e327ec66a5df1202920f08e8e51554a4), [`e584518`](https://github.com/knpkv/npm/commit/e584518c9c98186e331a9962c4c6347c470cb3c5), [`d476bb0`](https://github.com/knpkv/npm/commit/d476bb0b2e2399c72eb2cd7b8c6005d833464598), [`4ed3921`](https://github.com/knpkv/npm/commit/4ed39215d9d61071d6ce040b5a5cac77db963327), [`765e850`](https://github.com/knpkv/npm/commit/765e850895d4edc16a75b3af072f71d527ad0b8c)]:
  - @knpkv/herdr-connect@0.9.0
  - @knpkv/rly@0.16.0
  - @knpkv/herdr-work@0.9.3

## 0.13.0 (@knpkv/herdr-approvals)

### Minor Changes

- [#650](https://github.com/knpkv/npm/pull/650) [`87a811a`](https://github.com/knpkv/npm/commit/87a811a150578ac809316fe3bb0eb190a7f5e051) Thanks [@konopkov](https://github.com/konopkov)! - The hub no longer has a coordinator chat. The chat panel is gone from the Approvals dashboard and from below Connect's terminal, the page stops polling for chat, and the `GET`/`POST /v1/chat` routes are removed. The dashboard snapshot drops `chat` and `approvalApp.chatEnabled`, and `dashboardPolls` no longer reports `chat`. Notifications now show on the canonical hub whether or not chat history exists. A coordinator chat job queued before the upgrade still runs through Fleet's `runCoordinatorChat`. `@knpkv/herdr-coordinator`'s chat model and Fleet's chat operations are unchanged.

### Patch Changes

- [#638](https://github.com/knpkv/npm/pull/638) [`51db213`](https://github.com/knpkv/npm/commit/51db213028b228bfff75f0dbcfd5e9add0fffc9b) Thanks [@konopkov](https://github.com/konopkov)! - The hub preloads Geist Mono as well as Geist. Ids and kickers are set in mono, and loading that face late re-wrapped a line in the Approvals detail at 390, shifting the page.

- [#644](https://github.com/knpkv/npm/pull/644) [`9a0dbd7`](https://github.com/knpkv/npm/commit/9a0dbd7d08661cbcdeaef12be2dbe6c99d08c226) Thanks [@konopkov](https://github.com/konopkov)! - The hub takes the fonts it preloads from rly's list of web font faces instead of naming the files itself, so a face rly adds is preloaded too.
- Updated dependencies [[`132d46b`](https://github.com/knpkv/npm/commit/132d46bc0ed8a881737a0ead6db9b32cbbac4889), [`5594373`](https://github.com/knpkv/npm/commit/5594373fe3479fa7cbae68608f8b7b84606407e6), [`dfa2d94`](https://github.com/knpkv/npm/commit/dfa2d94ea207baeb281ef222c7d28cf98e4962bb), [`5d21796`](https://github.com/knpkv/npm/commit/5d21796fb856fba44a32395e316a6bd95ecdbdd6), [`aa41111`](https://github.com/knpkv/npm/commit/aa411113b76d81637f7af356bf04054246aa30ab), [`3ddf05b`](https://github.com/knpkv/npm/commit/3ddf05baa285beebba1ebe99bd2458434a613015)]:
  - @knpkv/herdr-connect@0.8.0
  - @knpkv/rly@0.15.0
  - @knpkv/herdr-work@0.9.2

## 0.12.0 (@knpkv/herdr-approvals)

### Minor Changes

- [#604](https://github.com/knpkv/npm/pull/604) [`0cb230c`](https://github.com/knpkv/npm/commit/0cb230c3a5ad2bde144f5cc5008dc7f0b5cdda8e) Thanks [@konopkov](https://github.com/konopkov)! - The fleet shell no longer acts on single bare keys. Tabs are `g` then `a` / `c` / `w` (Approvals, Connect, Work) within 1.5 seconds, agent search is Ctrl+K (Cmd+K), and `?` (or the masthead's "Keyboard shortcuts" button) lists every shortcut in a dialog; Alt combinations are left to the window manager. Typing in a field never triggers a sequence. The key rail above each tab is gone. The masthead reads on one line, says "3 hosts" rather than "3 configured hosts", and the Work tab keeps its page heading while its goals load or fail.

- [#621](https://github.com/knpkv/npm/pull/621) [`0b6ee77`](https://github.com/knpkv/npm/commit/0b6ee77ed2f18a4b4e055310e0e6f24194545961) Thanks [@konopkov](https://github.com/konopkov)! - A host's own dashboard page now hydrates cleanly. It was server-rendered as static markup, which merges adjacent text, and the browser then failed with React error [#418](https://github.com/knpkv/npm/issues/418) and re-rendered the page. It also stops polling `/v1/chat`, `/v1/push/config` and (when the fleet is cross-host) `/v1/work`, which that listener doesn't serve and which only answered 404. The dashboard snapshot's `approvalApp` gains `workEnabled`, set by the same rule the server uses to route `/v1/work`.

- [#620](https://github.com/knpkv/npm/pull/620) [`0c82504`](https://github.com/knpkv/npm/commit/0c825043b9911af87b99f3026c403280ea9e36c6) Thanks [@konopkov](https://github.com/konopkov)! - A failed hub refresh no longer replaces the whole app with "Host activity unavailable" and an error stack. The hub keeps showing the last update it had (the page's own snapshot if the very first refresh fails), with an inline "Couldn't refresh host activity. Showing the update from 09:41." notice and a Try again button. The cause goes to the log. `FleetShell` and `DashboardView` take an optional `notice` for page-level messages like this one, shown under the masthead in the page gutter.

### Patch Changes

- [#630](https://github.com/knpkv/npm/pull/630) [`3b3ae7d`](https://github.com/knpkv/npm/commit/3b3ae7d8c6f159e1e2d8ff79e5d3096fdefaefb1) Thanks [@konopkov](https://github.com/konopkov)! - Approvals: a request without an expiry says "No expiry" in its row and on its bar instead of leaving the clock's place empty; the "Waiting for you" count is the number listed, without an unexplained "+" (unchecked hosts and unloaded pages are said in words); and the machines panel is titled "Machines", lists this machine first without a loading spinner, and drops the "Fleet" eyebrow.

- [#626](https://github.com/knpkv/npm/pull/626) [`da04e85`](https://github.com/knpkv/npm/commit/da04e85df105627acbfcc017ee0f15e6f4d6f20d) Thanks [@konopkov](https://github.com/konopkov)! - An approval or other job write that finds the job store locked now answers 503 (`FleetStoreBusyError`, retryable) instead of 500. The approval proof survives, so retrying the same decision succeeds. Push-delivery and host-runner failures are still logged and skipped, now with a logging `Effect.catch` instead of a suppressed `Effect.ignore`.

- [#629](https://github.com/knpkv/npm/pull/629) [`74e28f3`](https://github.com/knpkv/npm/commit/74e28f3c6085b9c75bca7618ee65aedd3679c84f) Thanks [@konopkov](https://github.com/konopkov)! - Agent cards on the hub show each agent's state with its own icon instead of a spinner for everyone. A working agent's icon spins, and stays motionless when reduced motion is requested; idle, blocked and done agents have distinct still icons beside the state's word.

- [#618](https://github.com/knpkv/npm/pull/618) [`83ef4f7`](https://github.com/knpkv/npm/commit/83ef4f7c37fa14d4c43bc34288d57ceb9a5c2294) Thanks [@konopkov](https://github.com/konopkov)! - The hub writes its lines as phrases instead of joining facts with middots: "Showing 24 of 30 matching, 30 jobs in all", "Load earlier (6 remaining)", "claude, arch" for an agent, "knpkv/npm#433: existing owner" for a Work job, and "Host activity on SER8" as the page title. The keyboard hint reads "In the list, J and K move, Enter opens details and Esc clears the search", and J/K never act while a field inside the list has focus or a modifier is held. At phone width the activity filters wrap instead of scrolling sideways, so the last one ("Agent") no longer sits past the screen edge. The middot ast-grep rule now covers herdr-approvals.

- [#623](https://github.com/knpkv/npm/pull/623) [`c47e854`](https://github.com/knpkv/npm/commit/c47e8544c762aeb58a28811106e3acf768af12b1) Thanks [@konopkov](https://github.com/konopkov)! - The hub no longer jumps while its first content loads. Connect's agent directory and the Work board each hold a screen of space until their first content arrives, through a failed first request and its retry, so the coordinator chat (Connect) and the agents and history panels (Work) stay out of view instead of being pushed down when the list or board arrives. CLS on a cold load was 0.60 (Connect, 768) and 0.48 (Work, 1440).

- [#624](https://github.com/knpkv/npm/pull/624) [`321dd50`](https://github.com/knpkv/npm/commit/321dd50955037fa17c5da7c7be96a9b5d43efb31) Thanks [@konopkov](https://github.com/konopkov)! - The hub's agent lines and activity rows wrap instead of cutting text off. At phone width an agent's name and work no longer shrink to a few characters next to its state (the state drops under them instead), and activity titles and descriptions show in full at 768 and below. At 320 the Activity history search field stays inside its card, and the filter chips keep their inline padding. Below 24rem an activity row's time sits above its title, so titles no longer break mid-word, and the search placeholder fits.

- [#593](https://github.com/knpkv/npm/pull/593) [`dd7a33a`](https://github.com/knpkv/npm/commit/dd7a33a7377370f381ba67d4eb4f9e2bb4961597) Thanks [@konopkov](https://github.com/konopkov)! - Text no longer jumps when Geist loads. rly's font stacks fall back to metric-matched Arial, Liberation Sans or Arimo faces (and Courier New, Liberation Mono or Cousine for mono), sized per weight, so lines break and rows stand the same height before and after the swap wherever glyphs are placed at subpixels (desktop Chrome on Linux as measured, and the usual macOS and Windows defaults); a Linux desktop set to full hinting can still move text slightly. Reading measures and title widths are set in `em` (at the weight each is drawn in) rather than `ch`, whose size follows the font's "0" and changed by 16% on the swap. Product shells preload the Geist file their stylesheet loads, and review's offline guide no longer hides the page until its fonts are ready.

- [#633](https://github.com/knpkv/npm/pull/633) [`1ba73ff`](https://github.com/knpkv/npm/commit/1ba73ff7cd71d9683175a1ef9df24f325988e04f) Thanks [@konopkov](https://github.com/konopkov)! - The hub's activity filter chips get their inline padding back (they referenced a spacing token rly doesn't define), and keyboard key caps name their bottom edge colour explicitly instead of through an undefined token, with no visual change.
- Updated dependencies [[`addf81d`](https://github.com/knpkv/npm/commit/addf81ddd5956692b571b5ecfc8ec2f3b3413aa2), [`da04e85`](https://github.com/knpkv/npm/commit/da04e85df105627acbfcc017ee0f15e6f4d6f20d), [`c47e854`](https://github.com/knpkv/npm/commit/c47e8544c762aeb58a28811106e3acf768af12b1), [`dd7a33a`](https://github.com/knpkv/npm/commit/dd7a33a7377370f381ba67d4eb4f9e2bb4961597), [`ae23e4d`](https://github.com/knpkv/npm/commit/ae23e4d56302af2916e5655e27736bb954e525ae), [`c15ee76`](https://github.com/knpkv/npm/commit/c15ee763636ef1d8f006ddd31c71df771748f9db)]:
  - @knpkv/herdr-coordinator@0.3.7
  - @knpkv/herdr-fleet@0.8.0
  - @knpkv/herdr-connect@0.7.4
  - @knpkv/rly@0.14.0
  - @knpkv/herdr-work@0.9.1

## 0.11.1 (@knpkv/herdr-approvals)

### Patch Changes

- Updated dependencies [[`16244c5`](https://github.com/knpkv/npm/commit/16244c58b41cd8dcee799fd8e8e058598df3fb90), [`0d6cc4d`](https://github.com/knpkv/npm/commit/0d6cc4df23eca64c5d29725bf50899776cc52435), [`26bc385`](https://github.com/knpkv/npm/commit/26bc385b4fafdffaf246cbdfa06995b3ecf66047)]:
  - @knpkv/herdr-connect@0.7.3
  - @knpkv/herdr-work@0.9.0
  - @knpkv/rly@0.13.0
  - @knpkv/herdr-coordinator@0.3.6

## 0.11.0 (@knpkv/herdr-approvals)

### Minor Changes

- [#602](https://github.com/knpkv/npm/pull/602) [`58aca11`](https://github.com/knpkv/npm/commit/58aca112c21203ee8955b130d5d891dabe2976a2) Thanks [@konopkov](https://github.com/konopkov)! - The Work tab decides a goal's approval request in place: its bar approves or rejects through the same call as the Approvals tab, shows the decision waiting for the hub, and says how the hub answered (taken, refused, or not yet known). Its clock reads hub time, like the Approvals countdown, and both tabs use the same clock words. An answer belongs to the request it decided, so a new request on the same job starts with a ready bar.

### Patch Changes

- Updated dependencies [[`69eb086`](https://github.com/knpkv/npm/commit/69eb08644a3b9e39ba97fd0205a985e5e7208a26), [`bfba87c`](https://github.com/knpkv/npm/commit/bfba87c566ca21d267c0626da60b431757dc5e32)]:
  - @knpkv/herdr-fleet@0.7.0
  - @knpkv/herdr-work@0.8.1
  - @knpkv/herdr-connect@0.7.2
  - @knpkv/herdr-coordinator@0.3.5

## 0.10.0 (@knpkv/herdr-approvals)

### Minor Changes

- [#512](https://github.com/knpkv/npm/pull/512) [`f3e0012`](https://github.com/knpkv/npm/commit/f3e0012b6106b3d142b8469f327f366b9aa2ba1f) Thanks [@konopkov](https://github.com/konopkov)! - The Approvals tab is a countdown:

  - It leads with the request that expires first ("4m 12s until Apply Nix configuration expires").
  - Every pending request, from this host and others, is listed soonest first, with its time left.
  - One decision bar sits on the selected request and names what it decides.

  Decisions show the hub's answer, including a refusal, never an assumed success. A request becomes expired only when the hub says so; at zero its clock reads "expiring". Screen readers hear a request once as it enters its last minute and when it expires, not every tick. Keyboard shortcuts follow the same rules as the buttons, so a request decided on another host, or one already being sent, can't be decided by keyboard either.

### Patch Changes

- [#581](https://github.com/knpkv/npm/pull/581) [`c22e8ae`](https://github.com/knpkv/npm/commit/c22e8ae0c55a50e9c1edbd46a1cd18108f62e4fa) Thanks [@konopkov](https://github.com/konopkov)! - Mark existing silent fallbacks (failures turned into success without a log) with a follow-up lint suppression. No behaviour change.
- Updated dependencies [[`c22e8ae`](https://github.com/knpkv/npm/commit/c22e8ae0c55a50e9c1edbd46a1cd18108f62e4fa), [`1ef72d9`](https://github.com/knpkv/npm/commit/1ef72d9317a37e8f28563cae113e9908d8242c3a), [`f8e842e`](https://github.com/knpkv/npm/commit/f8e842e901986b50edf55f98fa3591b742a7904e), [`30849c5`](https://github.com/knpkv/npm/commit/30849c598fdf6776a3a4a2c4061d276e843eaa8e)]:
  - @knpkv/herdr-connect@0.7.1
  - @knpkv/rly@0.12.1
  - @knpkv/herdr-work@0.8.0
  - @knpkv/herdr-coordinator@0.3.4

## 0.9.0 (@knpkv/herdr-approvals)

### Minor Changes

- [#548](https://github.com/knpkv/npm/pull/548) [`0125a64`](https://github.com/knpkv/npm/commit/0125a6414d23989eae1d89ab0523dd09a1a7b5e1) Thanks [@konopkov](https://github.com/konopkov)! - Connect knows where a terminal is really scrolled to. The hub reads herdr's scroll position for the open pane (at most twice a second per session and ten times a second across the host) and sends it to the browser, so a pane someone left scrolled back opens with "Older output, N lines back", and Latest returns in exactly that many lines, one command per frame, until a fresh reading says the pane is at the bottom. Readings are taken only while no scroll is in flight and carry the number of scrolls they cover, so the browser uses only those that already include every scroll it sent. Hosts send it only to clients that ask for it, so hubs and hosts can be upgraded in any order. When the position can't be read it is shown as unknown, never as the bottom, and Connect falls back to its previous behaviour.

### Patch Changes

- [#575](https://github.com/knpkv/npm/pull/575) [`655f010`](https://github.com/knpkv/npm/commit/655f010c2bb14b4118d81c60025ac64006b73f1c) Thanks [@konopkov](https://github.com/konopkov)! - Focus rings match rly's: a solid 2px outline in the focus colour, 2px outside the control, from `--rly-focus-ring-width` and `--rly-focus-ring-offset`. Hand-rolled 1px to 3px rings, rings in agent, service or text colours, tinted halos and box-shadow rings are gone. Rings inside clipped containers pull the ring width inside.
- Updated dependencies [[`0125a64`](https://github.com/knpkv/npm/commit/0125a6414d23989eae1d89ab0523dd09a1a7b5e1), [`655f010`](https://github.com/knpkv/npm/commit/655f010c2bb14b4118d81c60025ac64006b73f1c), [`4965043`](https://github.com/knpkv/npm/commit/4965043541a324f630b847ed4d852b6722f6efe6)]:
  - @knpkv/herdr-connect@0.7.0
  - @knpkv/herdr-work@0.7.2
  - @knpkv/rly@0.12.0

## 0.8.0 (@knpkv/herdr-approvals)

### Minor Changes

- [#572](https://github.com/knpkv/npm/pull/572) [`74429d4`](https://github.com/knpkv/npm/commit/74429d4719b471ab7aaae230ad594f6c5e1755fb) Thanks [@konopkov](https://github.com/konopkov)! - The hostd composer receives `startedWorker(jobId)`, the worker Fleet's job record says that job started, or null when the job is unknown or started none. A background writer that acts on an agent can check its identity against this record instead of pane metadata, which any local agent can write. A job store that can't be read, or a composition without one, fails with `FleetStoreError`, never null.

### Patch Changes

- [#559](https://github.com/knpkv/npm/pull/559) [`8171e47`](https://github.com/knpkv/npm/commit/8171e47d54136a7f1b48572e3fc5c5a184bc7250) Thanks [@konopkov](https://github.com/konopkov)! - `fleetctl submit HOST work.* <json>` says what is wrong with the payload, in one line: each failing field and what it expected, for example `work.abandon payload: goalId: Missing key; reason: Expected string`. The payload's `kind` may be left out; it is the command's own. Before, any problem printed only "work.abandon payload is invalid".

- [#557](https://github.com/knpkv/npm/pull/557) [`d215ab8`](https://github.com/knpkv/npm/commit/d215ab87781bd00f9199f3c04b0c3a901075efbb) Thanks [@konopkov](https://github.com/konopkov)! - The coordinator chat no longer shows a hard-coded host name or a "Persistent" chip; turns read "You asked" or "You asked for work" with their state as a word, and the scrolling history is a named log a keyboard can reach. The notifications panel explains a blocked or unsupported browser instead of offering an Enable button that cannot work, names the cause when checking fails, and keeps its setup help inside the panel.
- Updated dependencies [[`d215ab8`](https://github.com/knpkv/npm/commit/d215ab87781bd00f9199f3c04b0c3a901075efbb), [`6d215b2`](https://github.com/knpkv/npm/commit/6d215b2fa9bb3e98f447efbbddcb299c41a4efc5)]:
  - @knpkv/herdr-connect@0.6.0
  - @knpkv/rly@0.11.0
  - @knpkv/herdr-work@0.7.1

## 0.7.0 (@knpkv/herdr-approvals)

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

## 0.6.0 (@knpkv/herdr-approvals)

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

## 0.5.4 (@knpkv/herdr-approvals)

### Patch Changes

- Updated dependencies [[`487f2ba`](https://github.com/knpkv/npm/commit/487f2ba4fdb585f0cd0b2ab96fd4eeedce9da10d), [`8363bd4`](https://github.com/knpkv/npm/commit/8363bd4dd5fc6df3b15ae70132c080bd52d19a0f)]:
  - @knpkv/rly@0.8.0
  - @knpkv/herdr-work@0.5.3
  - @knpkv/herdr-connect@0.4.4

## 0.5.3 (@knpkv/herdr-approvals)

### Patch Changes

- Updated dependencies [[`d5ee299`](https://github.com/knpkv/npm/commit/d5ee299ce3fa5584f2f54051009828af4a26fe4b)]:
  - @knpkv/rly@0.7.0
  - @knpkv/herdr-connect@0.4.3
  - @knpkv/herdr-work@0.5.2

## 0.5.2 (@knpkv/herdr-approvals)

### Patch Changes

- [#469](https://github.com/knpkv/npm/pull/469) [`0fd9544`](https://github.com/knpkv/npm/commit/0fd95449194e83de61109d432224acc043f57964) Thanks [@konopkov](https://github.com/konopkov)! - New `@knpkv/bounded-io` package: `limitBytes`, `collectBounded` and `collectBoundedText` read a stream under a byte budget and fail with `ByteLimitExceeded` on the chunk that crosses it. The AI CLI runners and the Herdr command, terminal, Tailscale and HTTP-body readers now use it instead of their own copies; their errors and limits are unchanged, and collection is linear instead of quadratic in the number of chunks.
- Updated dependencies [[`0fd9544`](https://github.com/knpkv/npm/commit/0fd95449194e83de61109d432224acc043f57964)]:
  - @knpkv/bounded-io@0.2.0
  - @knpkv/herdr-connect@0.4.2
  - @knpkv/herdr-fleet@0.5.1
  - @knpkv/herdr-tailscale@0.3.1

## 0.5.1 (@knpkv/herdr-approvals)

### Patch Changes

- [#463](https://github.com/knpkv/npm/pull/463) [`2df424b`](https://github.com/knpkv/npm/commit/2df424b8e9c2b33dbb59a34954d84b2ff8903b1e) Thanks [@konopkov](https://github.com/konopkov)! - Every `node:sqlite` Herdr store now opens its database through the new `@knpkv/herdr-fleet/sqlite` opener. An existing group/other-writable state directory or database is now refused at startup and left unchanged; previously the approval store quietly restricted it before Work could refuse it, and `jobs.sqlite` was never checked. `WorkStore.open` now restricts an existing state directory to `0700`, as the other stores already did. The coordinator's orchestrator database reuses the shared path checks with no behaviour change.
- Updated dependencies [[`2df424b`](https://github.com/knpkv/npm/commit/2df424b8e9c2b33dbb59a34954d84b2ff8903b1e)]:
  - @knpkv/herdr-fleet@0.5.0
  - @knpkv/herdr-work@0.5.1
  - @knpkv/herdr-connect@0.4.1
  - @knpkv/herdr-coordinator@0.3.1

## 0.5.0 (@knpkv/herdr-approvals)

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

## 0.4.0 (@knpkv/herdr-approvals)

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

## 0.3.0 (@knpkv/herdr-approvals)

### Minor Changes

- [#398](https://github.com/knpkv/npm/pull/398) [`929b851`](https://github.com/knpkv/npm/commit/929b851d6fa105e326ebb6ee66325978dd124fd5) Thanks [@konopkov](https://github.com/konopkov)! - Add stable form identities for the Work activity search and Connect terminal inputs.

- [#392](https://github.com/knpkv/npm/pull/392) [`da8c8c0`](https://github.com/knpkv/npm/commit/da8c8c08b144a2ea8dfd837ecfa433cae1ad13a7) Thanks [@konopkov](https://github.com/konopkov)! - Bind persisted Work approval targets to the configured approval page origin before recording them.

### Patch Changes

- Updated dependencies [[`da8c8c0`](https://github.com/knpkv/npm/commit/da8c8c08b144a2ea8dfd837ecfa433cae1ad13a7), [`75ece0a`](https://github.com/knpkv/npm/commit/75ece0ab3d666488bc32820aeef56adb0873cead), [`75ece0a`](https://github.com/knpkv/npm/commit/75ece0ab3d666488bc32820aeef56adb0873cead), [`929b851`](https://github.com/knpkv/npm/commit/929b851d6fa105e326ebb6ee66325978dd124fd5)]:
  - @knpkv/herdr-work@0.3.0
  - @knpkv/herdr-connect@0.3.0
  - @knpkv/rly@0.5.0

## 0.2.0 (@knpkv/herdr-approvals)

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
