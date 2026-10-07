---
"@knpkv/rly": minor
"@knpkv/control-center": patch
---

`ServiceMark` takes a `name` variant: `visible` (default) prints the provider name, and `hidden` prints the glyph only, where an adjacent title already names the provider. The accessible name is present either way. The mark no longer draws a provider-coloured rail.

Control Center's Services cards use the hidden name, so the provider is no longer printed twice.
