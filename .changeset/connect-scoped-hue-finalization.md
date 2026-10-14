---
"@knpkv/herdr-connect": minor
"@knpkv/herdr-hub": patch
---

Add scoped, single-flight optional hue enrichment and bind it to the hub's server lifetime. Return an uncoloured directory when hue permission finalization exceeds its wait budget, while keeping mandatory activity observations independent. Shutdown interrupts the owned worker, joins for at most two seconds and closes its connection, logging a typed warning if uninterruptible cleanup remains pending.
