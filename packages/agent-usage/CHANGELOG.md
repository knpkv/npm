# @knpkv/agent-usage

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
