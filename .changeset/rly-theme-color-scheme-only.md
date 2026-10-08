---
"@knpkv/rly": patch
---

rly's colour tokens are declared once on `:root` as `light-dark()`; a `[data-theme]` subtree only switches `color-scheme`, and its descendants resolve the matching value. Themed subtrees no longer re-declare every colour, so a themed subtree inside `[data-forced-colors="active"]` keeps the forced system colours.
