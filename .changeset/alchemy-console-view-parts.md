---
"@knpkv/alchemy-console": minor
---

Export the stack page's parts from `./views` so a host can compose its own page around them: `StackResourcesView` (the resource table), `StackOutputsView` (the outputs list) and `StackStateTree` (resources grouped by construct parent and type). `StackResourcesView` and `StackStateTree` take `resourceHref: null` to render resource names as plain text for a host with no resource page. `StackDetailView` renders the same parts as before.

The empty-state creatures are now CSS backgrounds instead of `<img>` elements whose URL came from `import.meta.url`, so `./views` loads in bundles without `import.meta.url`. A consumer's CSS build must resolve the stylesheet's SVG `url()`s.

The plan's source line no longer prints commit hashes: it reads "PR #n · published <time>", with the head and base commits in its tooltip.
