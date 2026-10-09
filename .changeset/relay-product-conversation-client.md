---
"@knpkv/relay-product": minor
---

Adds `@knpkv/relay-product/client`, a Relay conversation in the browser for any `ObjectRef`.

- One stream per conversation, read as server-sent events, reconnecting from a fresh Snapshot.
- 401/403 stops it with `Unauthorized`; an unreadable frame stops it with `StreamFailed`.
- A shared store folds the events, so a late reader gets the current state, open cards included.
- A person's message shows when the stream reports it queued or placed, never on the send's answer.
- `send` takes the composer's request id (`newRequestId`), so a retry after a lost answer lands once; `send`, `cancel` and `decide` return typed refusals.
- `retry` reopens a stream that ended with `Unauthorized` or `StreamFailed`.
- The session backend's status is read beside the stream, the newest read winning, after each Snapshot, run end and send.

`@knpkv/relay` is an optional peer, used only by this entry.
