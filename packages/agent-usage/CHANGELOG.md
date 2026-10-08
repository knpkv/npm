# @knpkv/agent-usage

## 0.5.6

### Patch Changes

- [#588](https://github.com/knpkv/npm/pull/588) [`26bc385`](https://github.com/knpkv/npm/commit/26bc385b4fafdffaf246cbdfa06995b3ecf66047) Thanks [@konopkov](https://github.com/konopkov)! - Add `StackedBars`: stacked values per period with limit bands above, a shaded window such as the current limit window, width-aware binning, and a single-stop keyboard span selection. Columns out of time order throw an error naming the column. The focus-ring lint now also holds SVG focus strokes to the shared width token, and reserves the focus colour for focus; agent-usage's chart focus stroke uses the token.
- Updated dependencies [[`26bc385`](https://github.com/knpkv/npm/commit/26bc385b4fafdffaf246cbdfa06995b3ecf66047)]:
  - @knpkv/rly@0.13.0

## 0.5.5

### Patch Changes

- [#581](https://github.com/knpkv/npm/pull/581) [`c22e8ae`](https://github.com/knpkv/npm/commit/c22e8ae0c55a50e9c1edbd46a1cd18108f62e4fa) Thanks [@konopkov](https://github.com/konopkov)! - Mark existing silent fallbacks (failures turned into success without a log) with a follow-up lint suppression. No behaviour change.
- Updated dependencies [[`c22e8ae`](https://github.com/knpkv/npm/commit/c22e8ae0c55a50e9c1edbd46a1cd18108f62e4fa)]:
  - @knpkv/rly@0.12.1

## 0.5.4

### Patch Changes

- [#575](https://github.com/knpkv/npm/pull/575) [`655f010`](https://github.com/knpkv/npm/commit/655f010c2bb14b4118d81c60025ac64006b73f1c) Thanks [@konopkov](https://github.com/konopkov)! - Focus rings match rly's: a solid 2px outline in the focus colour, 2px outside the control, from `--rly-focus-ring-width` and `--rly-focus-ring-offset`. Hand-rolled 1px to 3px rings, rings in agent, service or text colours, tinted halos and box-shadow rings are gone. Rings inside clipped containers pull the ring width inside.

- [#570](https://github.com/knpkv/npm/pull/570) [`c45b069`](https://github.com/knpkv/npm/commit/c45b069af37c78464332907fcb5cbe5903abf8a9) Thanks [@konopkov](https://github.com/konopkov)! - Executables linked from the repository (`pnpm link --global`, or `node dist/...`) run under plain Node: workspace packages resolve to their build output instead of TypeScript sources. Published `@knpkv/codecommit-core` now serves its `Domain.js`, `CacheService.js` and `SandboxService.js` subpaths; the last two resolved to files that do not exist before.
- Updated dependencies [[`4965043`](https://github.com/knpkv/npm/commit/4965043541a324f630b847ed4d852b6722f6efe6)]:
  - @knpkv/rly@0.12.0

## 0.5.3

### Patch Changes

- Updated dependencies [[`6d215b2`](https://github.com/knpkv/npm/commit/6d215b2fa9bb3e98f447efbbddcb299c41a4efc5)]:
  - @knpkv/rly@0.11.0

## 0.5.2

### Patch Changes

- Updated dependencies [[`c93baf2`](https://github.com/knpkv/npm/commit/c93baf29bba9d67ffc4938ce0b0ada533260fddc)]:
  - @knpkv/rly@0.10.0

## 0.5.1

### Patch Changes

- [#493](https://github.com/knpkv/npm/pull/493) [`e45eba3`](https://github.com/knpkv/npm/commit/e45eba30991dc662b7a8b09506d2d85b878fec97) Thanks [@konopkov](https://github.com/konopkov)! - `@knpkv/browser-pairing/owner-session` adds `serveWithBootstrapUrl(server, onReady)`. It runs a server layer, waits until it is listening, hands its bootstrap URL to `onReady`, and keeps serving. A launch that fails before it is listening fails without announcing a URL, and a failing `onReady` stops the server. `agent-usage serve`, `jcf-web` and `codecommit-web` now start their servers through it instead of three copies of that code. `@knpkv/codecommit-web` also exports `serveCodeCommit(options)` (`hostname`, `port`, `onReady`), the start sequence its own entry uses.
- Updated dependencies [[`934843b`](https://github.com/knpkv/npm/commit/934843bbcea57cbf3266fce950c020733046cac1), [`148daa6`](https://github.com/knpkv/npm/commit/148daa6be147dca74bc642bd552b603deb760eae), [`4e8f346`](https://github.com/knpkv/npm/commit/4e8f346b926b859ea2b3be07ec7dc6cb77ca8e76), [`e57bb6d`](https://github.com/knpkv/npm/commit/e57bb6db1b393dbff8e116573cf2db23992c1cf4), [`7df3dbb`](https://github.com/knpkv/npm/commit/7df3dbb9875ab31f369351df2de898b36d40e613), [`8924289`](https://github.com/knpkv/npm/commit/89242895271072b83185d6cc02376b2c56830f6a), [`f8d2612`](https://github.com/knpkv/npm/commit/f8d2612e09b20974dd8eccc8ff197bb072c40cbf), [`e45eba3`](https://github.com/knpkv/npm/commit/e45eba30991dc662b7a8b09506d2d85b878fec97)]:
  - @knpkv/rly@0.9.0
  - @knpkv/browser-pairing@0.4.0

## 0.5.0

### Minor Changes

- [#484](https://github.com/knpkv/npm/pull/484) [`f06778a`](https://github.com/knpkv/npm/commit/f06778abd2e065eda14c0010a2916a3d1b71cb16) Thanks [@konopkov](https://github.com/konopkov)! - The server answers one Booking's sessions in a range at `/api/sessions`: each session's first and last request, requests, tokens and API-equivalent cost on that Booking, most cost first, capped at 200 rows with a count of the rest, over a range of at most 92 days. Same owner-session and origin checks as every read.

### Patch Changes

- [#489](https://github.com/knpkv/npm/pull/489) [`f76a90c`](https://github.com/knpkv/npm/commit/f76a90ccdf7f62a23301b5027f688bcb1f65bc64) Thanks [@konopkov](https://github.com/konopkov)! - Keep usage chart colors aligned with the selected theme, including scoped Storybook previews.
- Updated dependencies [[`487f2ba`](https://github.com/knpkv/npm/commit/487f2ba4fdb585f0cd0b2ab96fd4eeedce9da10d)]:
  - @knpkv/rly@0.8.0

## 0.4.1

### Patch Changes

- Updated dependencies [[`d5ee299`](https://github.com/knpkv/npm/commit/d5ee299ce3fa5584f2f54051009828af4a26fe4b)]:
  - @knpkv/rly@0.7.0

## 0.4.0

### Minor Changes

- [#468](https://github.com/knpkv/npm/pull/468) [`0fef7fb`](https://github.com/knpkv/npm/commit/0fef7fb84162380cf1f713ed40e98a5ccbdde804) Thanks [@konopkov](https://github.com/konopkov)! - Serve the built client with Effect's `HttpStaticServer` instead of three hand-rolled routers. jcf-web and agent-usage export `staticClient(root)` from `server/HttpApplication.js` in place of `isWithinDirectory`; jcf-web also exports `apiApplication` and `StaticRouter`, the two halves `application` merges, so a host can give the static client its own FileSystem. Visible changes: responses carry `Cache-Control: no-cache` plus ETag/304 and byte-range support, content types include a charset, only extensionless HTML navigations fall back to `index.html` (a missing `*.js` or an index-less directory is now 404), and a malformed percent-encoded path is a 404 (previously 500 in jcf-web and codecommit-web, 400 in agent-usage). codecommit-web's traversal guard no longer accepts sibling directories that share the client directory's name prefix.

## 0.3.0

### Minor Changes

- [#466](https://github.com/knpkv/npm/pull/466) [`f93ed3f`](https://github.com/knpkv/npm/commit/f93ed3f800ff7633c58389b27d3d6e99ff553fd0) Thanks [@konopkov](https://github.com/konopkov)! - Use the shared `@knpkv/browser-pairing/owner-session`. The `OwnerSession` module now exports `makeOwnerSession` and `ownerSessionAuthLayer` (agent-usage also `mintBootstrapUrl`); the secrets contract, bootstrap router and loopback helpers come from the shared module, and `makeServer`'s `ready` resolves with the bootstrap URL.

  BEHAVIOUR: `JCF_WEB_PUBLIC_ORIGIN` / `AGENT_USAGE_PUBLIC_ORIGIN` with a path, query or fragment now fails at startup instead of being stripped.

### Patch Changes

- Updated dependencies [[`f93ed3f`](https://github.com/knpkv/npm/commit/f93ed3f800ff7633c58389b27d3d6e99ff553fd0)]:
  - @knpkv/browser-pairing@0.3.0

## 0.2.1

### Patch Changes

- [#464](https://github.com/knpkv/npm/pull/464) [`f693080`](https://github.com/knpkv/npm/commit/f69308082ab1f73c1ae43037d01c60385dee06b7) Thanks [@konopkov](https://github.com/konopkov)! - `agent-usage --version` prints the installed package's version instead of a hardcoded `0.1.0`.

## 0.2.0

### Minor Changes

- [#460](https://github.com/knpkv/npm/pull/460) [`7d6fdbe`](https://github.com/knpkv/npm/commit/7d6fdbe736fcf59feb282165126fc4c39ed8ae45) Thanks [@konopkov](https://github.com/konopkov)! - Read claude-statusline's limit log (`AGENT_USAGE_CLAUDE_LIMITS`) as Claude limit readings next to the polls; keep every failed poll's typed reason and detail and show it on the gap and in the readings table; read Claude Code's own macOS Keychain item when a custom config directory is set; and keep the page current over an authenticated WebSocket instead of polling.

- [#461](https://github.com/knpkv/npm/pull/461) [`42f6a66`](https://github.com/knpkv/npm/commit/42f6a663bc27ac9865e6a9e4977b555ad33f9a0a) Thanks [@konopkov](https://github.com/konopkov)! - `agent-usage login [--open]` asks the running server for a fresh one-time link over an owner-only Unix socket in the store directory, so a server running as a service can be reached without restarting it. A second `serve` on the same store now refuses to start.

### Patch Changes

- [#457](https://github.com/knpkv/npm/pull/457) [`a2527be`](https://github.com/knpkv/npm/commit/a2527be3ddd1f52645fce763df11ecae4868e599) Thanks [@konopkov](https://github.com/konopkov)! - Small cost axis ticks keep distinct labels, a focused chart column keeps its breakdown when the pointer leaves, and `ToggleGroup` no longer reports a change when an arrow key lands on the option already chosen.
- Updated dependencies [[`a2527be`](https://github.com/knpkv/npm/commit/a2527be3ddd1f52645fce763df11ecae4868e599)]:
  - @knpkv/rly@0.6.1

## 0.1.0

### Minor Changes

- [#453](https://github.com/knpkv/npm/pull/453) [`5979746`](https://github.com/knpkv/npm/commit/597974685d6b05eed6bed58d7b2548055ad607c6) Thanks [@konopkov](https://github.com/konopkov)! - Add `@knpkv/agent-usage`: a local service and browser view for Claude and Codex subscription usage. It records every model request from Claude Code transcripts and Codex rollouts into a per-machine SQLite store, books it to the Jira ticket or repo it worked on, and graphs consumption over time, per ticket, and against the 5-hour and weekly limits.

- [#456](https://github.com/knpkv/npm/pull/456) [`fecd5b0`](https://github.com/knpkv/npm/commit/fecd5b05e26df62f87ea0f66f226cefdb685cc59) Thanks [@konopkov](https://github.com/konopkov)! - Rework the usage page: limits now lead, grouped by agent with a meter, a state word, time to reset and reading freshness; limits over time are one row per window that tells a reset nobody read apart from a failed reading; usage leads with the range total; filters, the booking table and the chart columns are reachable by keyboard and fit a phone.

### Patch Changes

- Updated dependencies [[`adfad78`](https://github.com/knpkv/npm/commit/adfad78662f20b698a2c6d76a70e824c52e22029), [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e), [`b2d229d`](https://github.com/knpkv/npm/commit/b2d229d2208fb9e7f2d9dc174ff12d769c5b8225), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`8022091`](https://github.com/knpkv/npm/commit/802209142207593461eaef384d31757f746a2452), [`fa695f0`](https://github.com/knpkv/npm/commit/fa695f0179c67701e468fcedcd07c4b738c9734a), [`08a1c42`](https://github.com/knpkv/npm/commit/08a1c42ba3e9c4505919477f8b601262fb07952e), [`6ce5d6a`](https://github.com/knpkv/npm/commit/6ce5d6a1919515b9701ba0f0ec78c01cb408b623), [`fecd5b0`](https://github.com/knpkv/npm/commit/fecd5b05e26df62f87ea0f66f226cefdb685cc59)]:
  - @knpkv/rly@0.6.0
  - @knpkv/browser-pairing@0.2.0
