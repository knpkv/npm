---
"@knpkv/jcf-web": minor
"@knpkv/agent-usage": minor
---

Use the shared `@knpkv/browser-pairing/owner-session`. The `OwnerSession` module now exports `makeOwnerSession` and `ownerSessionAuthLayer` (agent-usage also `mintBootstrapUrl`); the secrets contract, bootstrap router and loopback helpers come from the shared module, and `makeServer`'s `ready` resolves with the bootstrap URL.

BEHAVIOUR: `JCF_WEB_PUBLIC_ORIGIN` / `AGENT_USAGE_PUBLIC_ORIGIN` with a path, query or fragment now fails at startup instead of being stripped.
