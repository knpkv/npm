# @knpkv/rly

## 0.10.0

### Minor Changes

- [#509](https://github.com/knpkv/npm/pull/509) [`c93baf2`](https://github.com/knpkv/npm/commit/c93baf29bba9d67ffc4938ce0b0ada533260fddc) Thanks [@konopkov](https://github.com/konopkov)! - Controls default to tool density: `Button`, `IconButton`, `Select`, and the `Field` control gain a `dense` size (32px, small radius, sized to text) and use it when no size is given (`ThemeSelect` and the `AgentJob` cancel action too), through new shared `--rly-control-height-*` tokens (`RLY_CONTROL_HEIGHT_TOKEN_NAMES`). Compact `IconButton` is 40px like the other compact controls (it was 44). `ToggleGroup` gains the same dense default, drawn as an outlined row with 1px dividers instead of a tinted track, and its `compact` and `default` sizes now follow the 40px and 48px control heights; the registry lists `dense` as the default size. Coarse pointers keep a 44px target. One-sided accent stripes are gone from rly: diff annotations, the file-tree error, stale findings, agent outcomes, thread evidence, verdict reasons, workset gaps, and the `StatePanel` rail now use an even border or a flat tint, and `lint:stripes`, now part of the repository lint gate, keeps them from coming back. The diff file tree marks the open file with an even ring and draws its guide lines in the neutral divider colour. A neutral `StatePanel` shows no icon unless `icon` names one. Control Center's header actions, Settings inputs and selects, and service setup fields move to the same dense height, so they line up with rly buttons.

  `StateLabel` renders a state as its word and icon in the tone's ink, with no border, tint or padding, so it never reads as a status chip. rly text no longer uses `overflow-wrap: anywhere`: words wrap only between words, and only an unbreakable token breaks (`break-word`), so a squeezed row never splits a word. Control Center Services: the card header keeps the title whole beside its state, and resource rows and test evidence lose their one-sided stripes. Codecommit-web's pull-request state links keep the 32px control target now that the state is a plain word.

## 0.9.0

### Minor Changes

- [#510](https://github.com/knpkv/npm/pull/510) [`934843b`](https://github.com/knpkv/npm/commit/934843bbcea57cbf3266fce950c020733046cac1) Thanks [@konopkov](https://github.com/konopkov)! - Add chart foundations: eight series colour tokens plus a neutral remainder (`--rly-color-series-*`), `LimitTrack` (a 0–100% limit with a near mark, a projected extension, and a stale hatch), `TrackKey` for the marks, and `ChartLegend` with `rlySeriesColor`.

- [#505](https://github.com/knpkv/npm/pull/505) [`148daa6`](https://github.com/knpkv/npm/commit/148daa6be147dca74bc642bd552b603deb760eae) Thanks [@konopkov](https://github.com/konopkov)! - Add `DecisionBar`: approve or reject one named target. The target and its clock stay visible, and both actions carry the target in their accessible names. An `off` state keeps them focusable with the reason linked, and `sending` waits for the server's answer instead of assuming success. `placement="sticky"` pins the bar at thumb reach on phones.

- [#504](https://github.com/knpkv/npm/pull/504) [`4e8f346`](https://github.com/knpkv/npm/commit/4e8f346b926b859ea2b3be07ec7dc6cb77ca8e76) Thanks [@konopkov](https://github.com/konopkov)! - Add `Hero` and `HeroWord`: the one fact a screen leads with, as a sentence in text ink with its figure inside, plus an optional caption. The `line` size folds it to one line beside a detail, and `display` is for boards read from across a room. `HeroWord` gives only the state word blocked or held ink.

- [#500](https://github.com/knpkv/npm/pull/500) [`7df3dbb`](https://github.com/knpkv/npm/commit/7df3dbb9875ab31f369351df2de898b36d40e613) Thanks [@konopkov](https://github.com/konopkov)! - Add `Region`: one main page region as a bordered surface with a single header row (title, plain count, actions) above a rule. The section is named by its heading, the heading can take programmatic focus through `headingId`, and `tone="tray"` steps the surface down for regions that hold actionable cards.

- [#498](https://github.com/knpkv/npm/pull/498) [`8924289`](https://github.com/knpkv/npm/commit/89242895271072b83185d6cc02376b2c56830f6a) Thanks [@konopkov](https://github.com/konopkov)! - Add a `words` size to `StageRail` for rows and facts. Stages read as one line ("Build succeeded, Staging failed: integration tests, Prod waiting") with no markers, chips or owners. Only critical and caution states take ink, and the heading remains for assistive technology.

- [#502](https://github.com/knpkv/npm/pull/502) [`f8d2612`](https://github.com/knpkv/npm/commit/f8d2612e09b20974dd8eccc8ff197bb072c40cbf) Thanks [@konopkov](https://github.com/konopkov)! - Add optional `provenance` to `TimelineRow` events. The marker takes a shape (○ applied automatically, ● approved, ◆ waiting for approval, a hatched square for couldn't read, ▲ flag only) and the label says it in words. A new `TimelineProvenanceKey` keys the shapes. The shapes stay distinct in forced colours.

### Patch Changes

- [#515](https://github.com/knpkv/npm/pull/515) [`e57bb6d`](https://github.com/knpkv/npm/commit/e57bb6db1b393dbff8e116573cf2db23992c1cf4) Thanks [@konopkov](https://github.com/konopkov)! - Region stays inside its container when its title or body holds a token with no break point, such as a long branch name or id. The token breaks only where it cannot fit; words still wrap at spaces.

## 0.8.0

### Minor Changes

- [#486](https://github.com/knpkv/npm/pull/486) [`487f2ba`](https://github.com/knpkv/npm/commit/487f2ba4fdb585f0cd0b2ab96fd4eeedce9da10d) Thanks [@konopkov](https://github.com/konopkov)! - Add `useStoredTheme`, `useDocumentTheme`, `decodeRlyTheme`, and `ThemeSelect`, so apps share one way to remember, apply, and choose the theme instead of copying storage code. `useStoredTheme` takes an application-chosen key and lazily supplied storage, stays correct through server rendering and hydration, and keeps tabs in sync. `useDocumentTheme` themes `<html>` so the viewport canvas and scrollbars match. `Select` now shows a controlled value's label before its list mounts, including during server rendering.

## 0.7.0

### Minor Changes

- [#478](https://github.com/knpkv/npm/pull/478) [`d5ee299`](https://github.com/knpkv/npm/commit/d5ee299ce3fa5584f2f54051009828af4a26fe4b) Thanks [@konopkov](https://github.com/konopkov)! - Add `Notice`, an inline one-sentence message with a state tone, optional action, and opt-in live-region announcement. Use it where packages hand-rolled tinted note paragraphs; `StatePanel` stays for titled, region-level states. `StatePanel` docs now explain that a polite status region must already be mounted to announce reliably, while an assertive alert may announce on insertion. Components that set their own `display` now still honour the native `hidden` attribute, through a new last `rly.state` layer that unlayered application CSS can still override. The open `RelayDock` trigger keeps its layout box and is `inert` instead of `hidden`. `StatePanel` no longer drops a caller-supplied `role` when it is not announcing.

## 0.6.1

### Patch Changes

- [#457](https://github.com/knpkv/npm/pull/457) [`a2527be`](https://github.com/knpkv/npm/commit/a2527be3ddd1f52645fce763df11ecae4868e599) Thanks [@konopkov](https://github.com/konopkov)! - Small cost axis ticks keep distinct labels, a focused chart column keeps its breakdown when the pointer leaves, and `ToggleGroup` no longer reports a change when an arrow key lands on the option already chosen.

## 0.6.0

### Minor Changes

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

- [#424](https://github.com/knpkv/npm/pull/424) [`fa695f0`](https://github.com/knpkv/npm/commit/fa695f0179c67701e468fcedcd07c4b738c9734a) Thanks [@konopkov](https://github.com/konopkov)! - Keep Fleet tabs in one compact iPhone row, preserve terminal pointer access, and distinguish Work loading and failure states.

- [#456](https://github.com/knpkv/npm/pull/456) [`fecd5b0`](https://github.com/knpkv/npm/commit/fecd5b05e26df62f87ea0f66f226cefdb685cc59) Thanks [@konopkov](https://github.com/konopkov)! - Add a `ToggleGroup` primitive for choosing one of a few peer options, and a `density="compact"` variant on `EntityTable` whose narrow cards lead with the first column and lay the rest out as a two-column label and value grid.

### Patch Changes

- [#425](https://github.com/knpkv/npm/pull/425) [`adfad78`](https://github.com/knpkv/npm/commit/adfad78662f20b698a2c6d76a70e824c52e22029) Thanks [@konopkov](https://github.com/konopkov)! - Remove the scrollbar-like selection line from stacked mobile tabs.

- [#432](https://github.com/knpkv/npm/pull/432) [`b2d229d`](https://github.com/knpkv/npm/commit/b2d229d2208fb9e7f2d9dc174ff12d769c5b8225) Thanks [@konopkov](https://github.com/konopkov)! - Replace employer-specific names in fixtures, comments and prototype storage keys with neutral placeholders.

  The Control Center prototype uses a new demo storage namespace. Saved prototype state and theme preferences from the previous namespace are not loaded.

- [#376](https://github.com/knpkv/npm/pull/376) [`379b029`](https://github.com/knpkv/npm/commit/379b02947180d50d4a40cf4b7723851aa68fc183) Thanks [@konopkov](https://github.com/konopkov)! - Replace internal project names, keys and work descriptions in fixtures, examples and documentation
  with neutral placeholders. Nothing about behaviour changes; these are the strings a reader of a
  public package would otherwise see.

  `ClockifyApiClient`'s tests now compose their client once through `it.layer`, with each case
  declaring the response it wants, instead of providing a layer inside every test body.

- [#452](https://github.com/knpkv/npm/pull/452) [`6ce5d6a`](https://github.com/knpkv/npm/commit/6ce5d6a1919515b9701ba0f0ec78c01cb408b623) Thanks [@konopkov](https://github.com/konopkov)! - Update `@pierre/diffs` to 1.5.1, keeping the strict style-src theme patch, and `lucide-react` to 1.50.

## 0.5.1

### Patch Changes

- [#400](https://github.com/knpkv/npm/pull/400) [`1dcc473`](https://github.com/knpkv/npm/commit/1dcc473ebd14c2a4ac00d7fd67bf9a8d80201f66) Thanks [@konopkov](https://github.com/konopkov)! - Keep modal Relay focus trapping correct for controls inside nested open ShadowRoots.

## 0.5.0

### Minor Changes

- [#390](https://github.com/knpkv/npm/pull/390) [`75ece0a`](https://github.com/knpkv/npm/commit/75ece0ab3d666488bc32820aeef56adb0873cead) Thanks [@konopkov](https://github.com/konopkov)! - Add the shared responsive Relay Dock presentation pattern.

## 0.4.1

### Patch Changes

- [#382](https://github.com/knpkv/npm/pull/382) [`94ee004`](https://github.com/knpkv/npm/commit/94ee00487f0595cdc16fd8f1332689eb39ecfaf2) Thanks [@konopkov](https://github.com/konopkov)! - Run release-independent CodeCommit reviews through authenticated native Codex sandboxes, resolve AWS SSO profiles safely, preserve redacted review failure stages and causes, and make review setup, settings, service health, and narrow-screen navigation clearer.
  Review activity now scrolls independently, follows new output without stealing a reader's position, and keeps a multiline draft composer available while a run is active.

## 0.4.0

### Minor Changes

- [#373](https://github.com/knpkv/npm/pull/373) [`9364cc5`](https://github.com/knpkv/npm/commit/9364cc5834eda7f57c7724b9cd7052b6c9f6f15d) Thanks [@konopkov](https://github.com/konopkov)! - Add streamed web Relay progress, configurable prompt-only review profiles and environment skills, reload-safe finding conversations and exact-head re-review, independently scrolling findings and replies, a collapsible changed-file hierarchy, local acknowledge/reject decisions, bidirectional comment-to-diff navigation, and permission-gated publication of accepted findings as native line comments or file-anchored PR comments.

### Patch Changes

- [#372](https://github.com/knpkv/npm/pull/372) [`812468f`](https://github.com/knpkv/npm/commit/812468f8e98326f854b36df1bbc08095bd0c08b3) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade Storybook and keep its Node 26 build output free of the upstream loader deprecation warning.

- [#361](https://github.com/knpkv/npm/pull/361) [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2) Thanks [@konopkov](https://github.com/konopkov)! - Upgrade the workspace to Effect 4.0.0-rc.109, pin the vendored Effect reference to that exact upstream release, guard source/package alignment, and bound Control Center test concurrency for reliable CI execution.

## 0.3.0

### Minor Changes

- [#370](https://github.com/knpkv/npm/pull/370) [`27d2ca1`](https://github.com/knpkv/npm/commit/27d2ca18b0c0b0f8a252d461c0aaf10eb92e9ffc) Thanks [@konopkov](https://github.com/konopkov)! - Enforce the complete anti-slop rule set with zero accepted diagnostics and update affected APIs and implementations to satisfy the required contracts.

### Patch Changes

- [#361](https://github.com/knpkv/npm/pull/361) [`676419e`](https://github.com/knpkv/npm/commit/676419e39c395dd4cfea6d9ffaee7d002a3f75e2) Thanks [@konopkov](https://github.com/konopkov)! - Update Effect and effect-qb, migrate schema-tagged errors to the current Effect API, and adopt the dialect-scoped SQLite function and type APIs introduced by effect-qb 0.22.

## 0.2.0

### Minor Changes

- [#304](https://github.com/knpkv/npm/pull/304) [`2e7d563`](https://github.com/knpkv/npm/commit/2e7d563cf3a388ad291d570edb78ce726611ccf8) Thanks [@konopkov](https://github.com/konopkov)! - Cache immutable CodeCommit diff content and render complete pull-request changes through the worker-backed rly workbench with synchronous failure fallback. Expose canonical exact-line focus across split and stacked rly diff presentations.

- [#288](https://github.com/knpkv/npm/pull/288) [`145032b`](https://github.com/knpkv/npm/commit/145032bf3332a6a115d52ea5ed3a998455de87bf) Thanks [@konopkov](https://github.com/konopkov)! - Render application-owned rich line annotations across virtualized, stacked, split, worker-fallback, and bounded synchronous diff presentations while preserving review state and keyboard focus.

- [#266](https://github.com/knpkv/npm/pull/266) [`d973d9a`](https://github.com/knpkv/npm/commit/d973d9a4bb9753f9a907f182c6b14a4528266765) Thanks [@konopkov](https://github.com/konopkov)! - Add a lightweight diff workbench entrypoint for applications that do not load the syntax renderer.

- [#269](https://github.com/knpkv/npm/pull/269) [`2112142`](https://github.com/knpkv/npm/commit/21121422eb3a4f2be9d975ebb6015bc7381dd305) Thanks [@konopkov](https://github.com/konopkov)! - Render complete CodeCommit file changes as an on-demand split or unified line diff, and add a strict-budget rly diff entry backed by the Diffs parser.

### Patch Changes

- [#296](https://github.com/knpkv/npm/pull/296) [`d60165e`](https://github.com/knpkv/npm/commit/d60165e4630dc77b7a46ca05c2a2d206b040da14) Thanks [@konopkov](https://github.com/konopkov)! - Improve first-party Jira and Confluence synchronization compatibility, make connected service controls compact and status-first, and refine pull-request review feedback, keyboard flow, and confirmation.

## 0.1.1

### Patch Changes

- [#251](https://github.com/knpkv/npm/pull/251) [`bf74411`](https://github.com/knpkv/npm/commit/bf744117e07b84b28e139ee131687fd36d080e3e) Thanks [@konopkov](https://github.com/konopkov)! - Patch two high-severity transitive dependency advisories via `pnpm-workspace.yaml`
  overrides:

  - **fast-uri** — bump `<=3.1.3` to `^3.1.4` (GHSA-v2hh-gcrm-f6hx: host confusion
    via literal backslash authority delimiter). Pulled in through `ajv`; affects
    `@knpkv/confluence-to-markdown` and `@knpkv/rly`.
  - **fast-xml-parser** — bump the `@distilled.cloud/aws` override from `^5.3.4` to
    `^5.10.1` (GHSA-8r6m-32jq-jx6q: repeated DOCTYPE declarations reset entity
    expansion limits). Affects `@knpkv/codecommit-core` and `@knpkv/control-center`.

  No source changes; `pnpm audit --prod && pnpm audit --dev` now reports no known
  vulnerabilities.

## 0.1.0

### Minor Changes

- [#126](https://github.com/knpkv/npm/pull/126) [`c770262`](https://github.com/knpkv/npm/commit/c7702624d7e388f6e9e3cd0dc93845e195737406) Thanks [@konopkov](https://github.com/konopkov)! - Introduce the release-oriented rly design-system package with generated,
  validated public entry points and a bounded Storybook catalog. The catalog
  includes documentation, accessibility and interaction checks, deterministic
  Chromium teardown, presentation-state controls, and fail-closed visual change
  classification.

  Add generated semantic color, typography, spacing, shape, and motion tokens;
  light, dark, forced-color, and reduced-motion themes; self-hosted Geist font
  assets; contrast validation; and a fail-closed component color policy.

  Add SSR-safe `GlobalStyles`, controlled `ThemeProvider`, owned accessible
  `Icon`, framework-neutral `LinkProvider`, and custom-target `PortalProvider`
  foundations without exposing router, Radix, or icon-library types.

  Add the first nine owned primitives: `Text`, `Surface`, `Divider`, `Button`,
  `IconButton`, `StateLabel`, `Avatar`, `Skeleton`, and `StatePanel`. Publish their
  semantic CSS as one deterministic component layer with no runtime injection,
  and cover variant, accessibility, interaction, SSR, packed-consumer, and
  responsive Storybook contracts.

  Add controlled-first `Tabs`, `Field`, and `Select` primitives with owned public
  types, Radix-internal keyboard behavior, explicit labeling and error semantics,
  safe portal composition, and compact responsive states.

  Add owned compound `Dialog` and `Sheet` overlays with visible accessible names,
  native inert isolation, focus containment and restoration, scroll locking,
  nested cleanup, compact full-screen layouts, and token-driven motion.

  Add presentation-only provenance and collaborator patterns for all five
  services, explicit freshness and evidence references, named human roles, safe
  avatar fallbacks, controlled `+N people` expansion, compact layouts, and
  forced-color-safe identity.

  Add the deterministic Release Relay presentation contract with 16 stable,
  code-owned SVG symbols, exact compact and hero geometry, runtime tuple
  validation, and golden persisted vectors. Add a giant neutral Verdict with a
  caller-supplied reason and semantic rail, without deriving release identity or
  readiness in the design system.

  Add semantic delivery-stage and relationship patterns with complete
  zero-to-many cardinality, explicit missing endpoints, caller-supplied lifecycle
  and direction, equivalent chain and native-table views, deterministic keyboard
  order, and compact forced-color-safe reflow.

  Add release dossier, preview, workset, entity-shell, entity-table, and activity
  patterns. Cover six release outcomes, six-ticket and arbitrary-cardinality Jira
  worksets, explicit PR and pipeline dimensions, service-specific full-view
  shells, controlled sorting, complete degraded data states, human and agent
  actors, caller-selected dialog or compact-sheet previews, complete collaborator
  slots, visible decision rails, caller-owned shared-transition geometry, and
  focus-safe preview-to-full-view actions.

  Add first-class contextual agent and governed-action patterns with exact
  context/evidence/capability ordering, durable human/agent/system threads,
  provider job progress and truthful terminal states, explicit non-authorizing
  agent proposals, and confirmation-gated named human authorization. Cover
  focus stability, cancellation, 320px dark and forced-color layouts, and
  presentation-only callbacks with no provider or vendor execution.

  Add an isolated complete diff entry with explicit file-content states, a
  500-file-safe inventory, controlled header and semantic findings, and a compact
  bird's-eye workbench. Pin and wrap `@pierre/diffs` `CodeView` with split and
  stacked layouts, wrapping, context, selection, annotations, item versioning,
  scrolling, virtualization, bounded workers, and an announced synchronous
  fallback that never silently omits source changes. Give review findings an
  optional implementation-ready prevention plan covering the enforcement layer,
  target rule, reject/allow fixtures, and known detection boundary.

  Publish a fail-closed, schema-validated agent registry with deterministic
  component, variant, state, accessibility, search, and source metadata. Add
  maintainer scaffolding and package-boundary validation, ship every registry
  artifact through explicit exports, and document the complete design system in
  the indexed workspace docs site with its static Storybook catalog composed at
  a stable nested route.

### Patch Changes

- [#126](https://github.com/knpkv/npm/pull/126) [`c770262`](https://github.com/knpkv/npm/commit/c7702624d7e388f6e9e3cd0dc93845e195737406) Thanks [@konopkov](https://github.com/konopkov)! - Add canonical per-release Relay threads backed by bounded, authenticated local Codex or Claude turns, and preserve multiline agent answers in rly threads.

- [#141](https://github.com/knpkv/npm/pull/141) [`e966c29`](https://github.com/knpkv/npm/commit/e966c29526522e1eac112533e70e3e39041e3ced) Thanks [@konopkov](https://github.com/konopkov)! - Add the six-state Control Center portfolio with authoritative readiness and
  delivery-stage projections, compact Jira/PR/pipeline relationship totals, and
  large URL-backed All, Need attention, Deploying, and Shipped filters. Include
  the six-release browser reference fixture, recoverable empty views, live count
  coherence, stable focus, and keyboard/back/refresh acceptance coverage.

  Expose stable release-fact identifiers from rly so applications can apply
  service-specific accents without coupling to generated CSS module names.
