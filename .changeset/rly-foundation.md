---
"@knpkv/rly": minor
---

Introduce the release-oriented rly design-system package with generated,
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
