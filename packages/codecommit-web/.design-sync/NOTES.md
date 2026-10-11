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

The queue page (`PRListView` and its search, filter and activity pieces) and the pull request page
(`PRDetailView`, its header, revision, health, approvals, comments, lifecycle and description sections,
and the `PRFilesDiffView` diff frame) are in `./views`. Their atom-bound containers stay in the app.

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
- The queue card showed the header but no rows, and the diff frame's findings column was clipped ->
  both are page-wide -> column cards: `PRListView` at 1100x1600, `PRFilesDiffView` at 1200x700.
- `PRRevisionView`'s "Time to first review" read 19856.4d -> a fixture creation date at the epoch ->
  unknown health is shown through the `health` prop alone, with the normal fixture dates.

## Previews

- Data comes from the package's tests and e2e specs only (each file names its source on line 1).
  Shared data lives in `fixtures/*.ts`. Branded values use the domain's constructors
  (`PullRequestId.make`), as the tests do: the repository bans `as` assertions.
- Never use a CSS-module class in a preview: the names are hashed per build. Plain markup with rly and
  Tailwind classes only.
- `FilterSelectionIndicator` is shown inside a filter option row (label and count), as the sidebar
  uses it; alone it is a bare checkbox.
- States in which a component renders nothing are not cards: a deleted comment thread, lifecycle
  metrics while comments load or with no review evidence, an empty recent-activity list. Each preview's
  top comment says so.
- `PRFilesDiffView` never renders the drawer's contents, so its drawer state is `FindingsDrawerClosed`;
  the open drawer is the `FindingsDrawer` card. `PRRequirementDialogsView` is a modal (single card,
  Docker dialog); the Granted dialog stays in its `.jsx`.
- Not authored: the live sandbox editor (needs a server), interaction states (hover, open calendar,
  editing and saving), and states the tests have no fixtures for (a size distribution with data,
  `RollingStatus` phase sequences, notification permission variants).

## Known render warns

- `[TOKENS_MISSING]` for `--radix-select-*`: Radix sets them inline on an open select at runtime.
- Validate's `[GRID_OVERFLOW]` suggestions are applied as `cfg.overrides`: `FindingsDrawer` is a modal
  dialog (single card), as is `PRRequirementDialogsView`; `SettingsRelayView`, `PRRow`,
  `PRDetailHeaderView` and `PRDetailView` are wider than a grid cell (column).

## Re-sync risks

- The `dts.mjs` fork: diff against the bundled lib on skill updates.
- A component appears here only when it is exported from `src/views.ts`.
