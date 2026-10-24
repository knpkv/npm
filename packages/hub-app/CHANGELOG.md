# @knpkv/hub-app

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
