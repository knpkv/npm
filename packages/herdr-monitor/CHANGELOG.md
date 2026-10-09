# @knpkv/herdr-monitor

## 0.3.4

### Patch Changes

- [#687](https://github.com/knpkv/npm/pull/687) [`ab6b732`](https://github.com/knpkv/npm/commit/ab6b7329bcc49337a658abaaf708fba2ce9ced44) Thanks [@konopkov](https://github.com/konopkov)! - Browser builds now target Chrome 123, Edge 123, Firefox 120 and Safari 17.6, the floor the CSS already relies on for `light-dark()` and `safe` alignment. Before, they targeted Vite's default (Chrome 111, Safari 16.4), so Lightning CSS rewrote `light-dark()` into its custom-property polyfill. Built CSS now keeps `light-dark()` native. For `@knpkv/rly` consumers, the published stylesheet assumes those browsers.

## 0.3.3

### Patch Changes

- [#665](https://github.com/knpkv/npm/pull/665) [`28b9dbd`](https://github.com/knpkv/npm/commit/28b9dbdd6bf0a10e247ecbe36653b0f4273235ee) Thanks [@konopkov](https://github.com/konopkov)! - The board's stylesheet uses logical properties, so it follows the writing direction; no visual change.

## 0.3.2

### Patch Changes

- [#599](https://github.com/knpkv/npm/pull/599) [`ed263a1`](https://github.com/knpkv/npm/commit/ed263a1b0d20dd47341dc9ed19175a889b94e44a) Thanks [@konopkov](https://github.com/konopkov)! - Failures that were silently swallowed now say so. agent-usage's page reports a successful reply it cannot read instead of treating it as empty, and logs a failed control-socket exchange. herdr-monitor answers a publish that stalls past its deadline with 408 rather than 400, and logs every failed publish request.

## 0.3.1

### Patch Changes

- [#581](https://github.com/knpkv/npm/pull/581) [`c22e8ae`](https://github.com/knpkv/npm/commit/c22e8ae0c55a50e9c1edbd46a1cd18108f62e4fa) Thanks [@konopkov](https://github.com/konopkov)! - Mark existing silent fallbacks (failures turned into success without a log) with a follow-up lint suppression. No behaviour change.

## 0.3.0

### Minor Changes

- [#577](https://github.com/knpkv/npm/pull/577) [`cf525b3`](https://github.com/knpkv/npm/commit/cf525b35db5f65ee3b71f34656d1a5fe49d4c0d6) Thanks [@konopkov](https://github.com/konopkov)! - `herdr-monitor init` writes the publish and view keys to a private env file. Every CLI failure names the input to fix instead of one generic message: `publisher` fails with `InvalidOrigin`, `InvalidPublishToken`, `InvalidSnapshot`, `SnapshotTooLarge`, `MonitorUnreachable`, `PublishTimedOut` or `PublishRejected` (now with `origin`) instead of `PublishFailed`, and `MonitorConfigurationError` carries the failing `setting`. Commands have descriptions. On the board, cards end at their last fact, identifiers wrap only between words, and going offline no longer moves the board.

### Patch Changes

- [#575](https://github.com/knpkv/npm/pull/575) [`655f010`](https://github.com/knpkv/npm/commit/655f010c2bb14b4118d81c60025ac64006b73f1c) Thanks [@konopkov](https://github.com/konopkov)! - Focus rings match rly's: a solid 2px outline in the focus colour, 2px outside the control, from `--rly-focus-ring-width` and `--rly-focus-ring-offset`. Hand-rolled 1px to 3px rings, rings in agent, service or text colours, tinted halos and box-shadow rings are gone. Rings inside clipped containers pull the ring width inside.

## 0.2.0

### Minor Changes

- [#543](https://github.com/knpkv/npm/pull/543) [`79069ae`](https://github.com/knpkv/npm/commit/79069ae9259c27de664dcd82cfa357202d469c92) Thanks [@konopkov](https://github.com/konopkov)! - The board leads with one fact: who is blocked and why, or how many agents are working. The theme follows the system instead of staying dark. Cards name their state in a word, with no coloured top stripe, and list only the facts that were published. The facts that were not are named in one line. When the monitor cannot be reached, the last snapshot stays on screen with the time it was received. A rejected view key is reported next to the key field. Buttons keep their labels in forced colours. Durations read "10m" rather than "0h 10m". Labels use commas instead of middots.

## 0.1.0

### Minor Changes

- [#436](https://github.com/knpkv/npm/pull/436) [`72f5b86`](https://github.com/knpkv/npm/commit/72f5b86ede812cb0357bc85e83fc2f13e5e4597e) Thanks [@konopkov](https://github.com/konopkov)! - Add an isolated read-only agent status board with explicit authenticated snapshot publication, separate board-scoped view and publish credentials, bounded in-memory retention, a tablet browser UI and synthetic demo CLI.

### Patch Changes

- [#452](https://github.com/knpkv/npm/pull/452) [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade to Effect 4.0.0 stable. `effect` and every `@effect/*` dependency or peer dependency now require `4.0.0`; imports move from the removed `effect/unstable/*` paths to `effect/*`.
