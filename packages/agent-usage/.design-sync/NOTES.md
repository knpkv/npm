# design-sync notes: agent-usage

Sync of `@knpkv/agent-usage`'s page components to its claude.ai/design design-system project, pinned in
`config.json`. Package shape with authored previews. The shared rly fixes and grading conventions live
in the repository root `.design-sync/NOTES.md`; the multi-entry pattern is the same as the Relay app's
(`packages/relay-product/.design-sync/NOTES.md`).

## What is in the bundle

`app/` is a private aggregator package and the converter's entry. It re-exports the browser-safe
entries `./views`, `./limits` and `./usage` (never the root, which re-exports the server) plus rly's
`ThemeProvider` and `PortalProvider` for the card frame. `test/browser-entries.test.ts` keeps those
entries free of Node built-ins. `entries/styles.mjs` pulls the page stylesheet (`src/client/usage.css`,
which imports rly, limits and chart CSS).

## Setup on a fresh clone or worktree

- `pnpm install` plus the hook steps, then `pnpm --filter "@knpkv/agent-usage..." build`.
- Converter scripts staged at the repository root `.ds-sync/`;
  `ln -sfn ../../../.ds-sync/node_modules packages/agent-usage/.design-sync/node_modules` once per clone.
- Run converter commands from `packages/agent-usage`.

## Fixes (symptom -> cause -> fix)

- Why not the storybook shape: the package has one story file ("Current screen") that renders several
  components per story, so the converter cannot map stories to components. Previews are authored from
  the same fixture week instead, and the stories are the visual reference.
- Previews failed on `node:sqlite` -> the stories' fixture builder (`stories/fixtures/week.ts`) imports
  the server's store module -> `fixtures/week.json` is a snapshot of `buildWeek` for the four scenarios,
  made by `fixtures/generate.ts` in UTC; `fixtures/view.ts` shapes it the way the stories do.
- Booking swatches and bar colours were blank -> the series colours are scoped to `.usage-shell` ->
  every preview renders inside `fixtures/page.tsx`, the stories' page frame.
- Callback props dropped from the contracts -> same as the Relay app: fork `overrides/dts.mjs`.

## Previews

- `BookingTable` has no selected card: selecting a booking sets `aria-pressed` only, and the row looks
  the same. `usage.css` styles `tr[data-selected="true"]`, which the component never sets; check with
  the package owner whether that selection highlight is missing.
- `LiveIndicator` ticks against the page clock; its cards stamp the last update twelve seconds before
  mount, so the age text reads "12s ago" at capture.

## Known render warns

- none yet

## Re-sync risks

- `fixtures/week.json` goes stale when `stories/fixtures/week.ts` changes; rerun `generate.ts`.
- The `dts.mjs` fork: diff against the bundled lib on skill updates.
