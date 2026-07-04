---
"@knpkv/atlassian-common": major
---

BREAKING: PKCE and auth UUID helpers now use Effect's platform `Crypto` service.

`generateCodeVerifier()` now returns an `Effect` instead of a string, and
`computeCodeChallenge()` / `generateUUID()` now require a `Crypto.Crypto` service
in their Effect environment. Provide an appropriate platform layer such as
`@effect/platform-node/NodeCrypto.layer` at the runtime edge.
