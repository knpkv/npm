# @knpkv/herdr-usage

## 0.2.2

### Patch Changes

- Updated dependencies [[`5018c55`](https://github.com/knpkv/npm/commit/5018c55e103f52e2fab1343a6a0ace7dcec27324), [`38c3bc2`](https://github.com/knpkv/npm/commit/38c3bc2e4c91bc411bab592f73066ddf142b9e86)]:
  - @knpkv/herdr-connect@0.31.5
  - @knpkv/herdr-fleet@0.23.0

## 0.2.1

### Patch Changes

- [#1133](https://github.com/knpkv/npm/pull/1133) [`e14854e`](https://github.com/knpkv/npm/commit/e14854ecb0e8e5555dacf9009b1b8b4ba171184c) Thanks [@konopkov](https://github.com/konopkov)! - The Usage app starts when the hub runs it. It used to ask the hub for this machine's name while building its routes, before it listened. The hub answers an app only once it has read that app's manifest, so every start failed and the hub left Usage off as crashlooping. It now reads the machine's name only when a standalone run first reads this machine's usage.
- Updated dependencies [[`e14854e`](https://github.com/knpkv/npm/commit/e14854ecb0e8e5555dacf9009b1b8b4ba171184c)]:
  - @knpkv/hub-app@0.5.1

## 0.2.0

### Minor Changes

- [#1127](https://github.com/knpkv/npm/pull/1127) [`1367495`](https://github.com/knpkv/npm/commit/136749537d39d4b8cdfdc18ae78f816760c375b0) Thanks [@konopkov](https://github.com/konopkov)! - The Usage app groups its Limits header in the hub as the hub's own Usage did: it asks for the grouped header before the hub has lent an outlet, draws its title and tabs inline until then, names the hub's machine rather than the viewer, links its pages through the shell's `href` when the shell provides one, and, opened on the hub's own machine, links to the local agent-usage dashboard as the hub's Usage did.

### Patch Changes

- Updated dependencies [[`9bad0f1`](https://github.com/knpkv/npm/commit/9bad0f1312266acc6f166d91a8b756199f7610ad), [`1367495`](https://github.com/knpkv/npm/commit/136749537d39d4b8cdfdc18ae78f816760c375b0), [`1367495`](https://github.com/knpkv/npm/commit/136749537d39d4b8cdfdc18ae78f816760c375b0)]:
  - @knpkv/herdr-fleet@0.22.0
  - @knpkv/hub-app@0.5.0
  - @knpkv/herdr-connect@0.31.4

## 0.1.3

### Patch Changes

- Updated dependencies [[`36501ee`](https://github.com/knpkv/npm/commit/36501ee2b18aaf1cdd2d45789b649ce15881287c)]:
  - @knpkv/herdr-fleet@0.21.0
  - @knpkv/herdr-connect@0.31.3

## 0.1.2

### Patch Changes

- Updated dependencies [[`7ecb2d6`](https://github.com/knpkv/npm/commit/7ecb2d6f3a19d582d286768973a57dbab5786738)]:
  - @knpkv/rly@0.25.0
  - @knpkv/agent-usage@0.11.4
  - @knpkv/herdr-connect@0.31.2

## 0.1.1

### Patch Changes

- [#1095](https://github.com/knpkv/npm/pull/1095) [`dae5d9d`](https://github.com/knpkv/npm/commit/dae5d9dc2cda82f5d54ba9ccb2d38d099b6ebfba) Thanks [@konopkov](https://github.com/konopkov)! - Hub apps run without nix. **Breaking change to the attached app contract** (even at 0.x): an attached app no longer takes `--socket <path>`, `HUB_URL` or `HUB_APP_TOKEN_FILE`. The hub starts each installed app itself as `<node> <prefix>/<bin> --attach` and writes one handshake line on its stdin (`HubHandshake`: the endpoint, a unix socket or a Windows named pipe; the hub's URL; a token and a secret, both fresh per start and never written to disk). The app reads it within 5 s (at most 4 KiB), listens on the endpoint, answers `403 not_hub` to any request without the spawn's `x-hub-app-secret` (compared in constant time, before any `x-hub-*` header is read), and stops when stdin ends. `serveAttached` reads the handshake from stdin; `readRunMode` takes argv only; `AttachedOptions.token` is a `Redacted` value. `apps.json` is v2 only (`AppsConfig`, `InstalledApp`): it names its one writer (`cli` or `nix`), trusted scopes, and per app the install prefix, the script (`hubApp.bin`, a path inside the package), whether it is enabled and its heap cap; v1 files are refused. An app's package.json declares `"hubApp": { "bin", "contract", "services" }` (`HubAppPackageField`). App states gain `starting`, `crashloop`, `disabled`, `install_missing` and `health`, and `AppStartError` gains `handshake`.

  The hub supervises its apps: one child per entry, restarted with backoff (1 s up to 60 s) after an exit or three missed health probes, left off after 5 exits in 10 minutes until restarted, stopped by closing stdin (killed after 5 s). Output goes to a per-app log (5 MB, one previous file kept). Tokens are per spawn, held in memory and revoked when that spawn ends. Sockets live in an owner-only runtime directory the hub wipes at start and refuses when another user owns it or others can enter it. On Windows file modes do nothing: owner-only state comes from the user profile's ACL, an owner-only pipe DACL is not attempted, and the per-spawn secret is the check. `@knpkv/herdr-fleet`'s `HubPaths` gains `hubData`, `hubState` and `hubRuntime` (`null` on Windows). `herdr-usage` attaches the same way, and its package.json declares `hubApp` (`dist/bin.js`, contract 1, `fleet.read` and `host`).

- Updated dependencies [[`dae5d9d`](https://github.com/knpkv/npm/commit/dae5d9dc2cda82f5d54ba9ccb2d38d099b6ebfba)]:
  - @knpkv/hub-app@0.4.0
  - @knpkv/herdr-fleet@0.20.0
  - @knpkv/herdr-connect@0.31.1

## 0.1.0

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

### Patch Changes

- [#1094](https://github.com/knpkv/npm/pull/1094) [`e416078`](https://github.com/knpkv/npm/commit/e416078e075534f4681be5962e40c502492bfd71) Thanks [@konopkov](https://github.com/konopkov)! - Usage's pages no longer carry the removed `showInPhoneTitle` flag, so the package builds against `@knpkv/hub-app`'s current module descriptor.
- Updated dependencies [[`b323fee`](https://github.com/knpkv/npm/commit/b323fee9abea9aaf6fd4913465ef23f6830fca5e), [`df8ac0d`](https://github.com/knpkv/npm/commit/df8ac0dfdb5787065153cbe864272938f96c8c3d)]:
  - @knpkv/hub-app@0.3.0
  - @knpkv/herdr-connect@0.31.0
