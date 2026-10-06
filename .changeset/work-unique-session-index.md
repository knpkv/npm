---
"@knpkv/herdr-work": patch
---

`WorkStore.open` now enforces one coordinator handoff per session on files migrated from v1 handoffs. Those files gained `session_id` through `ALTER TABLE`, which cannot add a column UNIQUE constraint, and kept a plain session index; the SQL bridge's unique index never replaced it because `WorkStore` opens first. Opening such a file, with WorkStore or the SQL bridge, replaces the plain index with a unique one in one transaction, and fails closed (`open.database`, caused by `open.migrate.session-index`) if two handoffs already share a session, leaving the file unchanged.
