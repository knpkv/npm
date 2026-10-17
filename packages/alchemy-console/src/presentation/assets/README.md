# Decorative Stacks assets

Both external SVGs are MIT snapshots of the procedural Connect creature from
packages/herdr-connect/src/creature.tsx and character.ts, same repository and
owner. They use presentation attributes, with no style attributes or elements,
so the console's self-only CSP remains intact.

empty-creature.svg is the approved Stacks1c 88px stage-detail instance.
empty-state-creature.svg is the separate Stacks2c 56px cast-detail instance.
Keep the original size/detail pair; one is not a scaled substitute for the other.
Both are decorative and aria-hidden, drawn as CSS backgrounds from the view
stylesheets rather than resolved through import.meta.url, so the views load in
bundles that have none (the Relay Hub's IIFE client). A host's CSS build must
resolve the url(): the standalone console emits them as files, the Hub inlines them.
They introduce no runtime Connect dependency or host identity.
