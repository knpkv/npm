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
