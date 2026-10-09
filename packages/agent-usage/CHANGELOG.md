# @knpkv/agent-usage

## 0.8.0

### Minor Changes

- [#714](https://github.com/knpkv/npm/pull/714) [`b107010`](https://github.com/knpkv/npm/commit/b107010b57d13a6d4d5552e736a10e64f1367985) Thanks [@konopkov](https://github.com/konopkov)! - New `agent-usage usage [--range 24h|7d|30d] [--time-zone ZONE]`. It asks the running server for this Machine's tokens per period, agent and model, and its limit series over the range, and prints them as one JSON line (`UsageNow`, versioned). No cost, balance, Booking, session or path is in the answer, so another program (the herdr hub) may carry it across hosts. `@knpkv/agent-usage/usage` now exports `TokenUsageChart`, whose props have no `measure`, in place of `UsageChart`, and the chart's accessible `label` is required.

### Patch Changes

- Updated dependencies [[`7267362`](https://github.com/knpkv/npm/commit/72673622a770d5b40c695fe13b36a82f80e78cf4), [`8af4c75`](https://github.com/knpkv/npm/commit/8af4c7569dc195201e29dbf902b6bb221ec78f84), [`eb2ddfd`](https://github.com/knpkv/npm/commit/eb2ddfd124b3e8805d886fa26c178aa59231f1b4)]:
  - @knpkv/rly@0.18.0

## 0.7.0

### Minor Changes

- [#712](https://github.com/knpkv/npm/pull/712) [`a21684e`](https://github.com/knpkv/npm/commit/a21684e5ede609b9bf2b08d683e9b6c8efc04272) Thanks [@konopkov](https://github.com/konopkov)! - New `@knpkv/agent-usage/usage` entry, with `@knpkv/agent-usage/usage.css`. It exports the page's two charts, `UsageChart` and `LimitChart`, so another browser surface can draw them. `stackSeries` stacks any named series per period, and `UsageChart` now takes `periods` instead of a whole usage report, so a caller can chart tokens without cost. The entry bundles for a browser without the server, the store or Node modules.

## 0.6.0

### Minor Changes

- [#702](https://github.com/knpkv/npm/pull/702) [`1f6cc4a`](https://github.com/knpkv/npm/commit/1f6cc4ae3e3302681ad52fd667515f13cbfbeb40) Thanks [@konopkov](https://github.com/konopkov)! - `agent-usage limits` prints this Machine's latest limits from the running server as one JSON line. Balances and spend stay on the authenticated page. It asks over the owner-only control socket, so another program on the same account (hostd, for Connect) can read them without a session cookie or a provider credential.

- [#703](https://github.com/knpkv/npm/pull/703) [`d19931f`](https://github.com/knpkv/npm/commit/d19931f8abbdf82ca154f0be10d74c58b8d09f64) Thanks [@konopkov](https://github.com/konopkov)! - `@knpkv/agent-usage/limits` exports the limit schemas, the limits model and the "Limits now" cards (`LimitsSummary`), safe to bundle for a browser, with their stylesheet at `@knpkv/agent-usage/limits.css`. Connect uses it to show the same cards. Each window's bar is now Rly's `LimitTrack`: the near mark sits at 80%, and an old reading is hatched.

- [#704](https://github.com/knpkv/npm/pull/704) [`fea24ef`](https://github.com/knpkv/npm/commit/fea24ef8e52da5918feb8a45ae314a6b670c0c6b) Thanks [@konopkov](https://github.com/konopkov)! - Connect shows Claude and Codex limits. A line under the summary names each agent's window closest to its limit ("Claude 86% 5-hour", "Codex unknown"), and a disclosure holds each host's "Limits now" cards from agent-usage. agent-usage's `LimitsSummary` takes an optional `title`, and gives each instance its own heading id.

### Patch Changes

- [#704](https://github.com/knpkv/npm/pull/704) [`fea24ef`](https://github.com/knpkv/npm/commit/fea24ef8e52da5918feb8a45ae314a6b670c0c6b) Thanks [@konopkov](https://github.com/konopkov)! - `@knpkv/agent-usage/limits` resolves from the built package. Its modules now live in `src/limits/`, so they build to `dist/limits/` instead of `dist/client/`, which the page build empties. The stylesheet moves to `src/limits/limits.css`; its `@knpkv/agent-usage/limits.css` path is unchanged.

- [#687](https://github.com/knpkv/npm/pull/687) [`ab6b732`](https://github.com/knpkv/npm/commit/ab6b7329bcc49337a658abaaf708fba2ce9ced44) Thanks [@konopkov](https://github.com/konopkov)! - Browser builds now target Chrome 123, Edge 123, Firefox 120 and Safari 17.6, the floor the CSS already relies on for `light-dark()` and `safe` alignment. Before, they targeted Vite's default (Chrome 111, Safari 16.4), so Lightning CSS rewrote `light-dark()` into its custom-property polyfill. Built CSS now keeps `light-dark()` native. For `@knpkv/rly` consumers, the published stylesheet assumes those browsers.
- Updated dependencies [[`8f49d5b`](https://github.com/knpkv/npm/commit/8f49d5bafad19c7e3163538f7acb2f0f7de4d2d1), [`0848452`](https://github.com/knpkv/npm/commit/0848452bb7faecbf71c207648b430b895429da32), [`1cecd7c`](https://github.com/knpkv/npm/commit/1cecd7c454fdbdf042f7a3fd25a200805500881f), [`48830f8`](https://github.com/knpkv/npm/commit/48830f89057919d23ca408192cb68ac1893c8e96), [`799414f`](https://github.com/knpkv/npm/commit/799414f37422e7aeaf0a36bb80d8d878d75f5a10), [`2540508`](https://github.com/knpkv/npm/commit/2540508d00dc60c3842817df8ca37ce6c6a6179b), [`0848452`](https://github.com/knpkv/npm/commit/0848452bb7faecbf71c207648b430b895429da32), [`1902d84`](https://github.com/knpkv/npm/commit/1902d84417dc050cd7fe7a2472071275424f1e4f), [`ab6b732`](https://github.com/knpkv/npm/commit/ab6b7329bcc49337a658abaaf708fba2ce9ced44)]:
  - @knpkv/rly@0.17.0

## 0.5.9

### Patch Changes

- [#668](https://github.com/knpkv/npm/pull/668) [`78f20b1`](https://github.com/knpkv/npm/commit/78f20b17eecfe4270311647fb14b89f688760cf2) Thanks [@konopkov](https://github.com/konopkov)! - A long booking summary keeps its full text in a tooltip, disclosures take a 44px target, booking buttons grow to 44px on touch screens, a focused chart column draws rly's focus ring (kept in forced colours), and the page sizes to the small viewport.
- Updated dependencies [[`69b015c`](https://github.com/knpkv/npm/commit/69b015cb21c15723688acff8a22515fdc4cd09d6), [`67f7ea1`](https://github.com/knpkv/npm/commit/67f7ea1a5e3c0281da1d627fce940975e2db0cf4), [`f5f5fd9`](https://github.com/knpkv/npm/commit/f5f5fd98dcea7b7df1b226043e89ffb6decaffad), [`ce3234a`](https://github.com/knpkv/npm/commit/ce3234a201e3336b17f22219c8215d11eecc3408), [`4a41bf8`](https://github.com/knpkv/npm/commit/4a41bf82e327ec66a5df1202920f08e8e51554a4), [`e584518`](https://github.com/knpkv/npm/commit/e584518c9c98186e331a9962c4c6347c470cb3c5), [`d476bb0`](https://github.com/knpkv/npm/commit/d476bb0b2e2399c72eb2cd7b8c6005d833464598), [`4ed3921`](https://github.com/knpkv/npm/commit/4ed39215d9d61071d6ce040b5a5cac77db963327), [`765e850`](https://github.com/knpkv/npm/commit/765e850895d4edc16a75b3af072f71d527ad0b8c)]:
  - @knpkv/rly@0.16.0

## 0.5.8

### Patch Changes

- Updated dependencies [[`dfa2d94`](https://github.com/knpkv/npm/commit/dfa2d94ea207baeb281ef222c7d28cf98e4962bb), [`5d21796`](https://github.com/knpkv/npm/commit/5d21796fb856fba44a32395e316a6bd95ecdbdd6), [`aa41111`](https://github.com/knpkv/npm/commit/aa411113b76d81637f7af356bf04054246aa30ab), [`3ddf05b`](https://github.com/knpkv/npm/commit/3ddf05baa285beebba1ebe99bd2458434a613015)]:
  - @knpkv/rly@0.15.0

## 0.5.7

### Patch Changes

- [#593](https://github.com/knpkv/npm/pull/593) [`dd7a33a`](https://github.com/knpkv/npm/commit/dd7a33a7377370f381ba67d4eb4f9e2bb4961597) Thanks [@konopkov](https://github.com/konopkov)! - Text no longer jumps when Geist loads. rly's font stacks fall back to metric-matched Arial, Liberation Sans or Arimo faces (and Courier New, Liberation Mono or Cousine for mono), sized per weight, so lines break and rows stand the same height before and after the swap wherever glyphs are placed at subpixels (desktop Chrome on Linux as measured, and the usual macOS and Windows defaults); a Linux desktop set to full hinting can still move text slightly. Reading measures and title widths are set in `em` (at the weight each is drawn in) rather than `ch`, whose size follows the font's "0" and changed by 16% on the swap. Product shells preload the Geist file their stylesheet loads, and review's offline guide no longer hides the page until its fonts are ready.

- [#639](https://github.com/knpkv/npm/pull/639) [`c33ead7`](https://github.com/knpkv/npm/commit/c33ead79cfcbcdb16bbb468229e5a35454e05998) Thanks [@konopkov](https://github.com/konopkov)! - The web app preloads Geist Mono as well as Geist, so ids and code text paint in the right face sooner and don't re-wrap a line when the font arrives.

- [#599](https://github.com/knpkv/npm/pull/599) [`ed263a1`](https://github.com/knpkv/npm/commit/ed263a1b0d20dd47341dc9ed19175a889b94e44a) Thanks [@konopkov](https://github.com/konopkov)! - Failures that were silently swallowed now say so. agent-usage's page reports a successful reply it cannot read instead of treating it as empty, and logs a failed control-socket exchange. herdr-monitor answers a publish that stalls past its deadline with 408 rather than 400, and logs every failed publish request.
- Updated dependencies [[`dd7a33a`](https://github.com/knpkv/npm/commit/dd7a33a7377370f381ba67d4eb4f9e2bb4961597), [`ae23e4d`](https://github.com/knpkv/npm/commit/ae23e4d56302af2916e5655e27736bb954e525ae), [`c15ee76`](https://github.com/knpkv/npm/commit/c15ee763636ef1d8f006ddd31c71df771748f9db)]:
  - @knpkv/rly@0.14.0

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
