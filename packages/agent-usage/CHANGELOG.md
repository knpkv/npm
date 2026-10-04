# @knpkv/agent-usage

## 0.1.0

### Minor Changes

- [#453](https://github.com/knpkv/npm/pull/453) [`5979746`](https://github.com/knpkv/npm/commit/597974685d6b05eed6bed58d7b2548055ad607c6) Thanks [@konopkov](https://github.com/konopkov)! - Add `@knpkv/agent-usage`: a local service and browser view for Claude and Codex subscription usage. It records every model request from Claude Code transcripts and Codex rollouts into a per-machine SQLite store, books it to the Jira ticket or repo it worked on, and graphs consumption over time, per ticket, and against the 5-hour and weekly limits.

- [#456](https://github.com/knpkv/npm/pull/456) [`fecd5b0`](https://github.com/knpkv/npm/commit/fecd5b05e26df62f87ea0f66f226cefdb685cc59) Thanks [@konopkov](https://github.com/konopkov)! - Rework the usage page: limits now lead, grouped by agent with a meter, a state word, time to reset and reading freshness; limits over time are one row per window that tells a reset nobody read apart from a failed reading; usage leads with the range total; filters, the booking table and the chart columns are reachable by keyboard and fit a phone.

### Patch Changes

- Updated dependencies [[`adfad78`](https://github.com/knpkv/npm/commit/adfad78662f20b698a2c6d76a70e824c52e22029), [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e), [`b2d229d`](https://github.com/knpkv/npm/commit/b2d229d2208fb9e7f2d9dc174ff12d769c5b8225), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`8022091`](https://github.com/knpkv/npm/commit/802209142207593461eaef384d31757f746a2452), [`fa695f0`](https://github.com/knpkv/npm/commit/fa695f0179c67701e468fcedcd07c4b738c9734a), [`08a1c42`](https://github.com/knpkv/npm/commit/08a1c42ba3e9c4505919477f8b601262fb07952e), [`6ce5d6a`](https://github.com/knpkv/npm/commit/6ce5d6a1919515b9701ba0f0ec78c01cb408b623), [`fecd5b0`](https://github.com/knpkv/npm/commit/fecd5b05e26df62f87ea0f66f226cefdb685cc59)]:
  - @knpkv/rly@0.6.0
  - @knpkv/browser-pairing@0.2.0
