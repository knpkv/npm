# design-sync notes: CodeCommit web

Sync of `@knpkv/codecommit-web`'s browser views to its claude.ai/design design-system project, pinned in
`config.json`. Package shape with authored previews. The shared rly fixes and grading conventions live
in the repository root `.design-sync/NOTES.md`; the aggregator pattern is the same as the Relay app's
(`packages/relay-product/.design-sync/NOTES.md`).

## What is in the bundle

`app/` is a private aggregator package and the converter's entry. It re-exports the published
`./views` build (`dist/views/index.js`, types from `dist/dts/views.d.ts`), never the root, which is the
server, plus rly's `ThemeProvider` and `PortalProvider` and react-router's `MemoryRouter` for the card
frame. `test/browser-entries.test.ts` keeps the views free of Node built-ins and of the owner-session
runtime. `entries/styles.mjs` pulls `dist/views/style.css`, which carries the layer order, rly,
Tailwind's utilities, the theme and the views' CSS modules.

The pages people see most (the queue, the pull request page, the review workspace) are atom-bound
containers and not in `./views` yet; their view extractions come first, then they join this bundle.

## Setup on a fresh clone or worktree

- `pnpm install` plus the hook steps, then `pnpm --filter "@knpkv/codecommit-web..." build`.
- Converter scripts staged at the repository root `.ds-sync/`;
  `ln -sfn ../../../.ds-sync/node_modules packages/codecommit-web/.design-sync/node_modules` once per
  clone.
- Run converter commands from `packages/codecommit-web`.

## Fixes (symptom -> cause -> fix)

- Callback props dropped from the contracts -> same as the Relay app: fork `overrides/dts.mjs`.
- Router links threw outside a router -> `PRRow` and the rail render `Link` -> `MemoryRouter` is the
  innermost provider of the card frame.
- Ages differed between the capture ("Updated 0s ago") and the live card ("Updated on 05.10.2026") ->
  the test fixtures carry absolute dates -> `fixtures/pull-requests.ts` and `fixtures/sandboxes.ts` set
  dates relative to module load, so a card reads the same wherever it renders.
- The long settings forms were cut off mid-section -> the 900x700 card viewport -> `cfg.overrides`
  gives `SettingsRelayView` and `SettingsSandboxView` a column card at 900x1200.

## Previews

- Data comes from the package's tests and e2e specs only (each file names its source on line 1).
  Shared data lives in `fixtures/*.ts`. Branded values use the domain's constructors
  (`PullRequestId.make`), as the tests do: the repository bans `as` assertions.
- Never use a CSS-module class in a preview: the names are hashed per build. Plain markup with rly and
  Tailwind classes only.
- `FilterSelectionIndicator` is shown inside a filter option row (label and count), as the sidebar
  uses it; alone it is a bare checkbox.
- Not authored: the live sandbox editor (needs a server), interaction states (hover, open calendar,
  editing and saving), and states the tests have no fixtures for (a size distribution with data,
  `RollingStatus` phase sequences, notification permission variants).

## Known render warns

- `[TOKENS_MISSING]` for `--radix-select-*`: Radix sets them inline on an open select at runtime.
- Validate's `[GRID_OVERFLOW]` suggestions are applied as `cfg.overrides`: `FindingsDrawer` is a modal
  dialog (single card), `SettingsRelayView` and `PRRow` are wider than a grid cell (column).

## Re-sync risks

- The `dts.mjs` fork: diff against the bundled lib on skill updates.
- A component appears here only when it is exported from `src/views.ts`.
