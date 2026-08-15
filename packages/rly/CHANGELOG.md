# @knpkv/rly

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
