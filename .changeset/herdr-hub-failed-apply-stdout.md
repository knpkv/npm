---
"@knpkv/herdr-hub": minor
---

A failed `nix.check` or `nix.apply` now reports the tail of its stdout after its stderr, so an error a tool writes to stdout (such as `brew bundle`'s) is no longer lost. Parsed commands' failures are unchanged.
