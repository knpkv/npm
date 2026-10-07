# @knpkv/herdr-monitor

## 0.2.0

### Minor Changes

- [#543](https://github.com/knpkv/npm/pull/543) [`79069ae`](https://github.com/knpkv/npm/commit/79069ae9259c27de664dcd82cfa357202d469c92) Thanks [@konopkov](https://github.com/konopkov)! - The board leads with one fact: who is blocked and why, or how many agents are working. The theme follows the system instead of staying dark. Cards name their state in a word, with no coloured top stripe, and list only the facts that were published. The facts that were not are named in one line. When the monitor cannot be reached, the last snapshot stays on screen with the time it was received. A rejected view key is reported next to the key field. Buttons keep their labels in forced colours. Durations read "10m" rather than "0h 10m". Labels use commas instead of middots.

## 0.1.0

### Minor Changes

- [#436](https://github.com/knpkv/npm/pull/436) [`72f5b86`](https://github.com/knpkv/npm/commit/72f5b86ede812cb0357bc85e83fc2f13e5e4597e) Thanks [@konopkov](https://github.com/konopkov)! - Add an isolated read-only agent status board with explicit authenticated snapshot publication, separate board-scoped view and publish credentials, bounded in-memory retention, a tablet browser UI and synthetic demo CLI.

### Patch Changes

- [#452](https://github.com/knpkv/npm/pull/452) [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade to Effect 4.0.0 stable. `effect` and every `@effect/*` dependency or peer dependency now require `4.0.0`; imports move from the removed `effect/unstable/*` paths to `effect/*`.
