# @knpkv/review

## 0.3.1

### Patch Changes

- Updated dependencies [[`d5ee299`](https://github.com/knpkv/npm/commit/d5ee299ce3fa5584f2f54051009828af4a26fe4b)]:
  - @knpkv/rly@0.7.0

## 0.3.0

### Minor Changes

- [#452](https://github.com/knpkv/npm/pull/452) [`755eafa`](https://github.com/knpkv/npm/commit/755eafab8c0bc3e82b00e2dd27c68d669a1de87e) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade to Effect 4.0.0 stable. `effect` and every `@effect/*` dependency or peer dependency now require `4.0.0`; imports move from the removed `effect/unstable/*` paths to `effect/*`.

- [#433](https://github.com/knpkv/npm/pull/433) [`8022091`](https://github.com/knpkv/npm/commit/802209142207593461eaef384d31757f746a2452) Thanks [@konopkov](https://github.com/konopkov)! - Add patch-based diff presentation and a reusable guided review reader with portable HTML export. Guides retain chapter coverage and source-line findings, use Rly presentation, and display attributable token usage, cost, and execution time.

  Accept no-prefix and explicitly configured custom-prefix Git patches, CRLF patch
  records, and copied-file identities. Validate usage subsets and source coordinates,
  and replace stale fix guidance when a finding has status.

  Reject overlapping or surplus hunk records, retain diagram updates during active rendering, and keep source attribution and review-context categories visible. Standalone test commands build the export assets first.

  Preserve recorded cost precision and copied source paths, recognize punctuated code-fence languages, and reject non-UTF-8 path bytes instead of collapsing file identities.

  Require file markers for text hunks, document explicit empty prefixes for ambiguous no-prefix paths, and print both guide and review panels through opt-in tab content retention.
  Retain completed diagrams during print media transitions instead of clearing them for an asynchronous system-theme redraw.
  Measure diagrams outside hidden tabs so theme changes preserve their printable dimensions.

  Reject duplicate or contradictory patch records, isolate diagram failures, and display a supplied comparison base.

  Expose a bundled diagram initializer for embedded guides, with host-owned cleanup, theme updates and print preservation. Retain variable-length code fences and ordered-list continuations; reject mode transitions on absent patch sides.

### Patch Changes

- [#452](https://github.com/knpkv/npm/pull/452) [`af0c0e0`](https://github.com/knpkv/npm/commit/af0c0e09ef9ceabda7fd819bced7eb6d1b33e3c3) Thanks [@konopkov](https://github.com/konopkov)! - Update Mermaid to 12 while keeping guide diagrams on the dagre layout and classic look they rendered with before.
- Updated dependencies [[`adfad78`](https://github.com/knpkv/npm/commit/adfad78662f20b698a2c6d76a70e824c52e22029), [`b2d229d`](https://github.com/knpkv/npm/commit/b2d229d2208fb9e7f2d9dc174ff12d769c5b8225), [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183), [`8022091`](https://github.com/knpkv/npm/commit/802209142207593461eaef384d31757f746a2452), [`fa695f0`](https://github.com/knpkv/npm/commit/fa695f0179c67701e468fcedcd07c4b738c9734a), [`6ce5d6a`](https://github.com/knpkv/npm/commit/6ce5d6a1919515b9701ba0f0ec78c01cb408b623), [`fecd5b0`](https://github.com/knpkv/npm/commit/fecd5b05e26df62f87ea0f66f226cefdb685cc59)]:
  - @knpkv/rly@0.6.0

## 0.2.1

### Patch Changes

- Updated dependencies [[`75ece0a`](https://github.com/knpkv/npm/commit/75ece0ab3d666488bc32820aeef56adb0873cead)]:
  - @knpkv/rly@0.5.0

## 0.2.0

### Minor Changes

- [#387](https://github.com/knpkv/npm/pull/387) [`4ad196f`](https://github.com/knpkv/npm/commit/4ad196f7fe5e6ed68b6646681123bc1f603979fa) Thanks [@konopkov](https://github.com/konopkov)! - Add provider-neutral review contracts, pure runtime state, and controlled profile/result UI.

### Patch Changes

- Updated dependencies [[`94ee004`](https://github.com/knpkv/npm/commit/94ee00487f0595cdc16fd8f1332689eb39ecfaf2)]:
  - @knpkv/rly@0.4.1
