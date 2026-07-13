# @knpkv/rly

`rly` is the release-oriented design system for `@knpkv/control-center`. It provides browser-safe presentation contracts for delivery decisions, service provenance, collaborators, governed agents, and complete pull-request diffs.

The package is intentionally application-independent: it contains no vendor clients, persistence, authorization, release hashing, or server runtime.

## Status

The package contract is established at `0.0.0` while its first `0.1.0`
component surface is built. Tokens and framework-neutral foundations are
available behind explicit exports.

## Tokens and global styles

Import browser-safe semantic token names from `@knpkv/rly/tokens`. Raw palette
values remain private and are emitted only into the generated CSS contract.

Import the global layers once at the application boundary:

```css
@import "@knpkv/rly/styles.css";
```

The stylesheet contains self-hosted Geist and Geist Mono variable fonts,
semantic `light-dark()` color pairs, typography, spacing, shape, motion, a
scoped reset, and base styles. Set `data-theme="light|dark|system"` on the rly
root; system is the default. Forced colors and reduced motion are handled
centrally.

Service accents identify provenance only. Readiness always uses a state word,
ink/tint pair, and geometry rather than a provider color.

Token sources, CSS, registry metadata, package exports, and visual catalog data
are generated together:

```bash
pnpm --filter @knpkv/rly codegen:check
pnpm --filter @knpkv/rly lint:colors
```

The color-policy lint rejects raw component colors, primitive palette
variables, and component-local theme/media overrides.

## Foundations

Import the stylesheet once, then establish an explicit controlled theme scope:

```tsx
import { Icon, LinkProvider, PortalProvider, ThemeProvider, type RlyLinkProps } from "@knpkv/rly"

const AppLink = ({ href, ...props }: RlyLinkProps) => <a {...props} href={href} />

export const App = () => (
  <ThemeProvider theme="system">
    <LinkProvider component={AppLink}>
      <PortalProvider>
        <Icon decorative name="check" />
        Ready
      </PortalProvider>
    </LinkProvider>
  </ThemeProvider>
)
```

`ThemeProvider` is controlled and performs no storage or preference reads.
`LinkProvider` accepts an application-owned anchor bridge without importing a
router. `PortalProvider` owns an in-tree target unless a custom target is
supplied; explicit `null` never falls back to the global document body. `Icon`
publishes an owned name and size vocabulary rather than vendor types.

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
