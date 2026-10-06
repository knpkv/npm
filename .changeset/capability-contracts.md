---
"@knpkv/capability": minor
---

New `@knpkv/capability` package: `defineContract` and `implement` declare a capability once, with Effect Schema input, output and failure and a `read`, `write` or `host` access level; `invoke`, `describeCall` and `inputJsonSchema` give every surface (Relay tools first) the same decoding, encoding and failure handling. Handlers cannot fail with undeclared errors, contract names are valid tool names, and gated contracts describe the exact action a person confirms.
