---
"@knpkv/herdr-hub": minor
---

Add `ModulePageMount.closeSelection(parentHref)` for targets opened through shell navigation. Code Close and Escape return through Back when the current shell opened the target from that exact parent; direct, reloaded or remounted targets close with replace instead. Other module-mount hosts must supply the new method.

Preserve foreign history-state keys and selection origin through query repairs. Closing dialogs retain focus ownership after cleanup, and Forward reopens the target without adding duplicate queue entries.
