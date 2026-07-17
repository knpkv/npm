---
"@knpkv/control-center": patch
---

Make fresh data-root publication and secret-store startup portable to macOS by
verifying canonical filesystem paths against pinned directory identities instead
of relying on Linux descriptor path aliases.
