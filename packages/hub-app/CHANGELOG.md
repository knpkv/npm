# @knpkv/hub-app

## 0.5.0

### Minor Changes

- [#1127](https://github.com/knpkv/npm/pull/1127) [`1367495`](https://github.com/knpkv/npm/commit/136749537d39d4b8cdfdc18ae78f816760c375b0) Thanks [@konopkov](https://github.com/konopkov)! - An installed app outside the `@knpkv` scope opens its page only on the hub's loopback listener for now. On every other listener `/v1/apps` lists it as Unavailable with the new reason `local_only` ("<label> opens only on this machine for now."), and its routes answer 503. An app's page runs with the hub page's authority, which on the hub's tailnet listener includes approving jobs, so until apps get their own origin only first-party pages open on every device. First-party is the package name the installer verified, never what the app reports. `herdr-hub apps add` says which applies before it installs.

- [#1127](https://github.com/knpkv/npm/pull/1127) [`1367495`](https://github.com/knpkv/npm/commit/136749537d39d4b8cdfdc18ae78f816760c375b0) Thanks [@konopkov](https://github.com/konopkov)! - The hub's shell mounts installed apps, and Usage moves out of the hub into the `@knpkv/herdr-usage` app. Install it with `herdr-hub apps add @knpkv/herdr-usage`; it appears where the hub's own Usage was, and its routes and bookmarks are unchanged. A hub without it says so on any Usage link. The dashboard snapshot gains `apps` (the registry's states for that listener and the authenticated login), `usageModule` is no longer one of `builtInModuleIds`, and `makeUsageModuleViews` is removed. `ShellContext` gains the optional `href` and `host`, and `AppClientModule` checks a loaded client module before a shell mounts it.

## 0.4.1

### Patch Changes

- [#1116](https://github.com/knpkv/npm/pull/1116) [`d26eb55`](https://github.com/knpkv/npm/commit/d26eb55cf1af32d8011cb36cecb0d01641b2a1ea) Thanks [@konopkov](https://github.com/konopkov)! - The Sandboxes owner is an allowed login on any tailnet node that is not a fleet host, not only the hub machine, so the owner signs the hub in to AWS and runs sandbox jobs from their own devices. Fleet approvals stay limited to approval nodes. `ModuleCaller` gains `owner`.

## 0.4.0

### Minor Changes

- [#1095](https://github.com/knpkv/npm/pull/1095) [`dae5d9d`](https://github.com/knpkv/npm/commit/dae5d9dc2cda82f5d54ba9ccb2d38d099b6ebfba) Thanks [@konopkov](https://github.com/konopkov)! - Hub apps run without nix. **Breaking change to the attached app contract** (even at 0.x): an attached app no longer takes `--socket <path>`, `HUB_URL` or `HUB_APP_TOKEN_FILE`. The hub starts each installed app itself as `<node> <prefix>/<bin> --attach` and writes one handshake line on its stdin (`HubHandshake`: the endpoint, a unix socket or a Windows named pipe; the hub's URL; a token and a secret, both fresh per start and never written to disk). The app reads it within 5 s (at most 4 KiB), listens on the endpoint, answers `403 not_hub` to any request without the spawn's `x-hub-app-secret` (compared in constant time, before any `x-hub-*` header is read), and stops when stdin ends. `serveAttached` reads the handshake from stdin; `readRunMode` takes argv only; `AttachedOptions.token` is a `Redacted` value. `apps.json` is v2 only (`AppsConfig`, `InstalledApp`): it names its one writer (`cli` or `nix`), trusted scopes, and per app the install prefix, the script (`hubApp.bin`, a path inside the package), whether it is enabled and its heap cap; v1 files are refused. An app's package.json declares `"hubApp": { "bin", "contract", "services" }` (`HubAppPackageField`). App states gain `starting`, `crashloop`, `disabled`, `install_missing` and `health`, and `AppStartError` gains `handshake`.

  The hub supervises its apps: one child per entry, restarted with backoff (1 s up to 60 s) after an exit or three missed health probes, left off after 5 exits in 10 minutes until restarted, stopped by closing stdin (killed after 5 s). Output goes to a per-app log (5 MB, one previous file kept). Tokens are per spawn, held in memory and revoked when that spawn ends. Sockets live in an owner-only runtime directory the hub wipes at start and refuses when another user owns it or others can enter it. On Windows file modes do nothing: owner-only state comes from the user profile's ACL, an owner-only pipe DACL is not attempted, and the per-spawn secret is the check. `@knpkv/herdr-fleet`'s `HubPaths` gains `hubData`, `hubState` and `hubRuntime` (`null` on Windows). `herdr-usage` attaches the same way, and its package.json declares `hubApp` (`dist/bin.js`, contract 1, `fleet.read` and `host`).

## 0.3.1

### Patch Changes

- [#1093](https://github.com/knpkv/npm/pull/1093) [`3486fa2`](https://github.com/knpkv/npm/commit/3486fa2b9c9a65ae0782d24d6115ee94fc78071d) Thanks [@konopkov](https://github.com/konopkov)! - The standalone shell keeps `/app/shell.css` for good only when it is asked for under its current hash; an older page's link gets `no-cache`. A shell stylesheet missing at start is read again on the next request instead of failing until restart.

## 0.3.0

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

- [#1091](https://github.com/knpkv/npm/pull/1091) [`df8ac0d`](https://github.com/knpkv/npm/commit/df8ac0dfdb5787065153cbe864272938f96c8c3d) Thanks [@konopkov](https://github.com/konopkov)! - Page metadata no longer has `showInPhoneTitle`: it was deprecated and ignored. A descriptor from an older app that still sends it decodes with the flag dropped; a descriptor literal typed as `ModuleDescriptor` that still writes it fails to compile with an excess-property error, so remove the flag from your descriptors. On a cold load the Hub's arrival focus lands on the page without painting a focus ring on a tab nobody reached by keyboard; the next Tab shows it as before.

## 0.2.0

### Minor Changes

- [#1078](https://github.com/knpkv/npm/pull/1078) [`0d60032`](https://github.com/knpkv/npm/commit/0d60032bdda09409bf752f56184626a85ced7d7f) Thanks [@konopkov](https://github.com/konopkov)! - On phones the Hub header shows the product name, a breadcrumb line under it names the module and page ("Fleet / Approvals"; the module alone when it has one page), and every module shows its heading and one-line purpose again. Page metadata `showInPhoneTitle` is deprecated and ignored.

## 0.1.0

### Minor Changes

- [#1073](https://github.com/knpkv/npm/pull/1073) [`b207797`](https://github.com/knpkv/npm/commit/b207797126eeebea22ca2b8bec4b34bbfeae5ce7) Thanks [@konopkov](https://github.com/konopkov)! - Add `@knpkv/hub-app`: the contract and runner for apps that run standalone on their own port and mount in the
  hub. An app is its own process: `runApp` serves it on loopback with an owner login, or on a unix socket the hub
  proxies to. The hub reads installed apps from `~/.config/herdr/apps.json` (re-read when it changes and every 30
  seconds), probes each app's manifest, keeps the last good one, and lists every app's state at `GET /v1/apps`. It
  proxies `/apps/<id>/*` with the caller and a single-use grant, and serves app-to-hub services under
  `/v1/app-services/*` with a per-app token. An app that is down, incompatible or misdeclared is marked
  unavailable and never stops the hub. The module contract and route helpers moved to `@knpkv/hub-app`;
  `@knpkv/herdr-hub/modules` and `/modules/server` re-export them for one release.
