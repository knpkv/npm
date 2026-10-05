---
"@knpkv/codecommit-web": minor
"@knpkv/codecommit": patch
---

Use the shared `@knpkv/browser-pairing/owner-session`. `makeOwnerSessionSecrets`, `ownerSessionOrigin`, `ownerSessionUrl`, `ownerSessionUrlForOrigin`, `requireLoopbackOrigin` and the secrets contract are replaced by `makeOwnerSession`, `loopbackOrigin` and `requireLoopbackHostname`; `makeServer` takes an optional `publicOrigin` and its `ready` resolves with the bootstrap URL.

BEHAVIOUR: API reads now apply Fetch Metadata, as jcf-web and agent-usage already did — a browser read marked cross-site, or same-site/`none` without the bound Origin, gets 403. Same-origin page requests and explicit clients without Fetch Metadata are unaffected.
