---
"@knpkv/relay": patch
---

On Bun, a second owner of a Relay store is refused as `RelayStoreLocked` again, not as a failed commit: the store lock runs its pragma, `BEGIN IMMEDIATE` and `COMMIT` one call at a time, because Bun's multi-statement `exec` reported the refused `BEGIN` as `cannot commit - no transaction is active`. When neither `node:sqlite` nor `bun:sqlite` can load, the lock's error now carries both causes, so a Node without `node:sqlite` reports its own failure.
