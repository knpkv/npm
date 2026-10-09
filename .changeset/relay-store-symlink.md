---
"@knpkv/relay": minor
---

Refuse a store directory or database that is a symbolic link with `RelayStoreLinked`, before Relay re-permissions or writes anything, so conversation content never lands where a link points.
