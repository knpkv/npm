# @knpkv/capability

## 0.1.0

### Minor Changes

- [#554](https://github.com/knpkv/npm/pull/554) [`4789d53`](https://github.com/knpkv/npm/commit/4789d53e55f8ec6919fcc0ae1793eb1d0c29bd4d) Thanks [@konopkov](https://github.com/konopkov)! - New `@knpkv/capability` package: `defineContract` and `implement` declare a capability once, with Effect Schema input, output and failure and a `read`, `write` or `host` access level; `invoke`, `describeCall` and `inputJsonSchema` give every surface (Relay tools first) the same decoding, encoding and failure handling. Handlers cannot fail with undeclared errors, contract names are valid tool names, and gated contracts describe the exact action a person confirms.
