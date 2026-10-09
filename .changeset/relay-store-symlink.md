---
"@knpkv/relay": minor
---

Refuse a store directory, database or SQLite sidecar file that is a symbolic link, even a dangling one, with `RelayStoreLinked`, before Relay re-permissions or writes anything, so conversation content never lands where a link points.
