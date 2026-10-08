---
"@knpkv/rly": minor
---

rly's reset lets block containers shrink below their content as flex and grid items (`min-inline-size: 0`; inline content such as icons and labels keeps its automatic minimum), wraps long words and URLs (`overflow-wrap: break-word`), and avoids lone last words (`text-wrap: pretty`) inside rly roots. A component that must not shrink states its own minimum.
