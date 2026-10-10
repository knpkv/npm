# design-sync notes: the Relay app

Sync of the Relay app's UI (four packages) to its claude.ai/design design-system project, pinned in
`config.json`. Package shape: no Storybook, previews are authored. The shared rly fixes and the
grading conventions live in the repository root `.design-sync/NOTES.md`; read that first.

## What is in the bundle

`app/` is a private aggregator package and the converter's entry (`cfg.entry`). Its `index.js` and
`index.d.ts` re-export the browser-safe UI entries of all four packages:

- `@knpkv/relay-product` root and `./client` (`RelayConversationPanel`).
- `@knpkv/herdr-hub/views`, never the hub root: the root re-exports the HTTP server and the store.
- `@knpkv/herdr-connect/surface` and `./usage`, never the Connect root: it pulls herdr-fleet's SQLite.
- `@knpkv/herdr-work/react`.
- rly's `ThemeProvider` and `PortalProvider`, used as the card frame (`cfg.provider`).

The browser entries are guarded by `test/browser-entries.test.ts` in herdr-hub and herdr-connect.
A UI component that should appear here must first be public on one of those entries.

## Setup on a fresh clone or worktree

- `pnpm install` plus the hook steps, then `pnpm --filter "@knpkv/herdr-hub..." build` (`cfg.buildCmd`
  builds all four packages and rly).
- Converter scripts staged at the repository root `.ds-sync/` (see the root NOTES).
- `ln -sfn ../../../.ds-sync/node_modules packages/relay-product/.design-sync/node_modules` once per
  clone: the `dts.mjs` fork imports ts-morph.
- Run every converter command from `packages/relay-product` (the converter resolves `.design-sync/`
  from the working directory):
  `node ../../.ds-sync/package-build.mjs --config .design-sync/config.json --node-modules ./node_modules --out ./ds-bundle`.

## Fixes (symptom -> cause -> fix)

- Browser bundle failed on `node:http`, `node:sqlite` ... -> the hub and Connect roots re-export server
  code -> bundle only the browser entries listed above.
- Every component outside relay-product had empty props (`[key: string]: unknown`) -> the converter
  reads types only from the entry package's own `.d.ts` tree -> the `app/` aggregator, whose
  `index.d.ts` re-exports the packages, so the type extractor follows them.
- Callback and aria props (`onRetry`, `onDecide`) were missing from the props contracts -> the
  extractor drops `on*`/`aria-*` props declared in another package as DOM noise, and behind the
  aggregator every component is "another package" -> fork `overrides/dts.mjs`: files outside
  `node_modules` count as own API.
- Every card threw `[SCHEDULER_MISSING]` -> `@effect/atom-react` imports `scheduler` directly for
  low-priority registry callbacks; the converter shims `scheduler` to a throw -> `app/tsconfig.json`
  maps `scheduler` to the real package through the converter's tsconfig-paths hook, which runs before
  the shim. A second scheduler instance is harmless here: atom-react only schedules its own callbacks.
- Previews threw "Sync adapter can only throw schema errors" -> a preview decoded fixtures with its own
  copy of `effect` against schemas from the bundle's copy -> previews never call `Schema.decode*` on a
  bundle schema; fixtures are written in decoded form.
- Floating pins rendered outside the card -> `PinnedAgents` `placement="float"` is `position: fixed` ->
  the preview frames those cells in a box with a transform, which becomes their containing block.

## Previews

- Data comes from each package's own test fixtures only (each file names its source on line 1). Never
  real hosts, people, paths or tokens: the project and this repository are public.
- Import components only from `@knpkv/relay-app-design-system` (the bundle global). Type-only imports
  from the owning package are fine; a value import of a package already in the bundle creates a second
  copy and splits React context or Effect identity.
- Not authored, by design: `ConnectSurface` and `UsageSurface` are whole-app mounts that poll the server
  and need an atom registry the bundle does not export. They ship the floor card.
- Interaction-only states are not cards: expanded rows, search, tab switching, the shortcut dialog, the
  open Relay panel inside `HubRelay`, pin overflow, keyboard navigation.

## Known render warns

- none. Validate's `[GRID_OVERFLOW]` suggestions are applied as `cfg.overrides` (`cardMode`): the
  shell, dashboard, stage and dock pieces position content with `position: fixed` or portals, so their
  cards show one story at full size.

## Re-sync risks

- The `dts.mjs` fork: diff it against the bundled lib on every skill update and re-apply the one-line
  rule.
- `app/esbuild-paths.json` points at `node_modules/.pnpm/node_modules/scheduler`, pnpm's hoisted copy. If the
  install layout changes, the mapping silently stops resolving and every card throws again.
- The aggregator re-exports entry files by relative path into each package's `dist`. A renamed entry
  file breaks the build loudly; a new public UI component appears only if it is on one of those entries.
- Previews mirror test fixtures by hand. When a fixture changes shape, the preview's type-only imports
  catch some of it; the rest shows as a broken card on the next capture.
