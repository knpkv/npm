# design-sync notes: @knpkv/rly

Sync of `packages/rly` (storybook shape) to the claude.ai/design project pinned in `config.json`.
Everything here is repo-specific; the design-sync skill's own docs cover the generic flow.

## Setup on a fresh clone or worktree

- `pnpm install`, then the hook steps from AGENTS.md ("New worktree").
- Build rly and its workspace deps: `pnpm --filter "@knpkv/rly..." build` (`cfg.buildCmd`).
- Reference storybook, from `packages/rly`:
  `node --disable-warning=DEP0205 node_modules/storybook/dist/bin/dispatcher.js build -c .storybook -o "$(git rev-parse --show-toplevel)/.design-sync/sb-reference" --disable-telemetry`.
  Not `pnpm storybook:build`: that writes `storybook-static/` and runs the warning gate.
- Converter deps go in `.ds-sync/` with the real npm binary, never the `npm` shell alias. In this
  environment `npm` is aliased to pnpm, which links `.ds-sync` into the workspace store and rewrites
  `pnpm-lock.yaml`. Use the absolute npm path (`whence -p npm`) and pin `playwright@1.63.0`, which is
  the repo's pin and matches the cached chromium build, so no browser download is needed.
- Forks import `esbuild`: `ln -sfn ../.ds-sync/node_modules .design-sync/node_modules` once per clone.
- Converter flags: `--node-modules packages/rly/node_modules --entry packages/rly/dist/index.js`.

## Fixes (symptom -> cause -> fix)

- [GENERAL] `_ds_bundle.css` was only an `@import` list and validate failed `[CSS_IMPORT_MISSING]` ->
  `dist/styles.css` is an aggregator (`fonts.css`, `generated-tokens.css`, `base.css`,
  `components.css`) and the converter copies it verbatim -> `entries/styles.mjs` imports
  `dist/styles.css` and is listed in `extraEntries`, so esbuild resolves the whole closure into
  `_ds_bundle.css`. The Geist woff2 files inline as data URLs, which also sidesteps
  `font-display: optional` dropping the face on first paint.
- [GENERAL] `[FONT_MISSING] "Geist", "Geist Mono"` -> rly's stacks are
  `"Geist Variable", "Geist", "Geist Fallback", ...` and only the variable faces ship ->
  `entries/geist-aliases.css` (in `extraFonts`) declares the plain names over the same woff2 files.
  Not a substitute: the same font files.
- [GENERAL] Diff components missing (`[TITLE_UNMAPPED]` for DiffCodeView etc.) -> they are exported
  only from subpaths (`./diff`, `./diff/patch`, `./diff/bounded`) -> those dist entries are in
  `extraEntries`. `Overview`, `FontFaces` and `Tokens` are docs-only stories -> `titleMap: null`.
- [GENERAL] Previews rendered without the catalog wrapper (white page, no `data-rly-catalog`) ->
  `packages/rly/.storybook/preview.tsx` only re-exports `@knpkv/storybook-config/preview`, and the
  converter's decorator gate looks for the word "decorators" in that file -> fork
  `overrides/source-storybook.mjs` also accepts a re-exported default. It also ignores stylesheet and
  font imports in the decorator bundle (styles ship via `_ds_bundle.css`), and exposes
  `window.__dsDecorators` / `window.__dsInitialGlobals`.
- [GENERAL] Stories that set `globals` (theme dark, forced colours; 37 stories in 31 files) rendered
  light on the preview side -> upstream compose passes `globals: {}` -> fork
  `overrides/preview-gen-storybook.mjs` merges `initialGlobals` with meta/story `globals` into the
  story context and re-runs the project decorators with them, nested inside the card's own wrapper.
  `viewport` globals are not reproduced: both capture sides use the same width anyway.
- [GENERAL] "Element type is invalid ... got: undefined" -> a story imports an internal helper
  (`RlyLink`, `PortalBoundary`) from a module that also exports a public component; the converter
  redirects the whole module to `window.Rly`, where the helper doesn't exist. Bundling the module from
  source would split React context identity, so the fix is an owned preview on public API:
  `previews/LinkProvider.tsx`, `previews/PortalProvider.tsx`, `previews/EntityTable.tsx`.
- DiffCodeView: `! preview build failed` on `@pierre/diffs/worker/worker.js?worker&url` -> the story
  imports `useDiffWorkerState` from `src/diff/worker-pool.tsx`, which is not public, so the source
  module bundles and hits a Vite-only import -> owned `previews/DiffCodeView.tsx`, a port of the story
  module on public API that carries the same compose wrapper. `ThemeTransition` (needs the internal
  `createDiffCodeView`) and `WorkerStates` (needs `useDiffWorkerState`) are in
  `overrides.DiffCodeView.skip`. Neither is reachable through the package's exports.
- `cardMode` overrides come straight from validate's `[GRID_OVERFLOW]` suggestions. Dialog's card
  shows `NestedIsolation` (the open state) via `primaryStory`.

## Grading conventions

- The reference storybook captures full-page, the preview captures the 700px viewport. A tall story
  therefore looks cut off on the preview side. That is framing, not a mismatch.
- Some reference captures show a fallback sans instead of Geist (Hero, DiffWorkbench): rly's
  `@font-face` uses `font-display: optional`, so a cold storybook page can paint without it. The
  preview inlines the faces and shows Geist. The preview side is right; not a mismatch.
- Previews don't run `play`; the reference does. Anything a `play` step changed shows only on the
  storybook side: a focus ring, an expanded group ("Show fewer"), a selected row or toggle, a
  resolved annotation, a "sent; waiting" line. The preview shows the story's initial state. Grade it
  a match when the initial-state rendering is right; it is not a component difference.

## Notes for product syncs (Relay app, codecommit-web, control-center, agent-usage, jira-clockify)

- Same storybook setup: every web package uses `@knpkv/storybook-config` via a one-line
  `.storybook/preview.tsx` re-export, so copy both forks (`overrides/*.mjs`) and their `libOverrides`
  entries. Without them previews lose the catalog wrapper and every story-level theme.
- Products render rly components. If the product bundle externalizes `@knpkv/rly`, include rly's CSS
  the same way (an `extraEntries` module importing `@knpkv/rly/styles.css`), plus the Geist aliases.
- Internal-helper imports from component modules will recur; owned previews on public API are the fix.
- Run heavy steps (install, builds, storybook build, compare captures) only while holding the
  machine's heavy-job baton.

## Design is the source of truth for visual style

- Each product's design project owns the look: layout, order, spacing, type, colour and motion
  style. Code follows it. Behaviour, data and accessibility stay owned by code and specs.
- A visual change starts in the design project. Its reference renders are exported, then the code
  PR matches them, with a design-vs-live comparison per state. A UI PR that changes visuals with no
  matching design change goes back.
- Tokens decided in a product's design project are ported into rly first, then this project is
  re-synced, and only then do products consume them. Product projects never fork rly tokens.
- Two kinds of project per product. The design-system projects listed below are code-synced
  component libraries: sync direction is code -> project, and the close-out replaces and deletes
  everything under `components/`, `tokens/`, `fonts/`, `_vendor/`, `_preview/` and `guidelines/`.
  Screens and reference renders live in a separate design project per product, which builds with
  that library. Never write screens into a design-system project.

## Product projects

Created empty, one claude.ai/design project per product. Each product's own sync pins its config
to the id below (base on this file and rly's config). Only `agent-usage` has a storybook today
(1 story); the others are package-shape syncs.

| Product        | Package(s)                                                         | projectId                              |
| -------------- | ------------------------------------------------------------------ | -------------------------------------- |
| Relay app      | `packages/relay-product` (dock, product adapter), `packages/relay` | `1e2e7162-8e3e-4942-9713-150785fa1576` |
| codecommit-web | `packages/codecommit-web`                                          | `131e6fac-c44d-4016-a1cb-f38e943dd304` |
| control-center | `packages/control-center`                                          | `2f873ed0-3fcf-4e90-ab4b-d033a80ba263` |
| agent-usage    | `packages/agent-usage`                                             | `9230c0c2-68df-4c2f-bd49-93db45a409f2` |
| jira-clockify  | `packages/jcf-web` (web), `packages/jira-clockify` (TUI)           | `1286ee1a-4c4c-4732-8e36-0157cc2982f1` |
| Woord          | separate repo (`dutch`); its own sync config lives there           | `2fd06415-9b3e-4711-a270-32764ce423ce` |

## Known render warns

- none. Validate prints only `[BUNDLE_EXPORT] 2 compound namespace(s)` (Dialog, Sheet), which is
  information, and `[STORY_CAP]` for RelayDock (first 6 of 12 stories compared).

## Component defects seen while grading

Both sides render these the same, so they grade as matches; they are rly bugs, not sync bugs.

- TimelineRow `Compact Forced Colors`: at compact width the title, actor kind, service mark and
  person overlap instead of wrapping.

## Re-sync risks

- Two forked lib modules (`source-storybook.mjs`, `preview-gen-storybook.mjs`): diff them against the
  bundled lib on every skill update and re-apply the small patches.
- `entries/geist-aliases.css` points at `packages/rly/dist/fonts/*.woff2`. If the font file names
  change in rly's build, the aliases silently stop resolving.
- Owned previews mirror story files by hand: LinkProvider, PortalProvider, EntityTable. When those
  stories change (`[STORY_CHANGED]`), update the owned copy.
- `_ds_bundle.js` is about 12 MB, close to the 12 MB per-file upload cap, mostly diff syntax
  highlighting. Watch `[FILE_TOO_LARGE]`.
