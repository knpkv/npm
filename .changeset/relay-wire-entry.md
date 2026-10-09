---
"@knpkv/relay": minor
---

Adds `@knpkv/relay/wire`, a browser-safe entry with Relay's event and session schemas and the HTTP contract every product's `/…/relay` routes speak (`RelayStreamFrame`, the write bodies, and `RelayUnavailableError`, `RelayConflictError` and `RelayBadRequestError`). It imports only `effect` and `@knpkv/capability`; the build and `test:pack` fail if it reaches anything else.

The event stream now reports a person's messages: a Snapshot lists the ones still `queued`, and `MessageQueued`, `MessagePlaced` and `MessageWithdrawn` follow each one, so a client never guesses from its own send. `Snapshot.queued` is a new required field.
