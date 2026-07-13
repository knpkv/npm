# @knpkv/rly

`rly` is the release-oriented design system for `@knpkv/control-center`. It provides browser-safe presentation contracts for delivery decisions, service provenance, collaborators, governed agents, and complete pull-request diffs.

The package is intentionally application-independent: it contains no vendor clients, persistence, authorization, release hashing, or server runtime.

## Status

The package contract is established at `0.0.0` while its first `0.1.0` component surface is built. Public components and themes will be added behind explicit exports.

## Component catalog

Storybook is the bounded development and review surface for `rly`. It binds to
localhost, does not open a browser, and exposes toolbar controls for theme,
forced colors, reduced motion, viewport, locale, and density.

```bash
pnpm --filter @knpkv/rly storybook
pnpm --filter @knpkv/rly storybook:build
```

`storybook:build` also validates that the static catalog contains both the
interactive story and its generated documentation route.

Browser checks are deliberately serialized to one Chromium worker. Install the
managed browser once, then run the complete catalog gate:

```bash
pnpm --filter @knpkv/rly exec playwright install chromium
pnpm --filter @knpkv/rly test:browser
```

The gate runs Storybook interaction and accessibility tests, builds the static
catalog, exercises its global presentation states, and verifies clean server
and browser teardown.

## Visual change classification

The generated visual catalog maps every public component to its stories and
tests. CI tooling can classify a Git range without shell interpolation:

```bash
pnpm --filter @knpkv/rly visual:classify --base origin/main --head HEAD
```

The command emits deterministic JSON. Missing refs, malformed Git output,
unknown paths, catalog drift, or changes to foundations and shared visual
configuration fail closed to a full visual run.
