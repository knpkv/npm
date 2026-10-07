---
"@knpkv/herdr-fleet": minor
"@knpkv/herdr-work": patch
---

Work activity for an approved reassignment or abandonment reads as a sentence: "Reassigned from host-coordinator to claude-coordinator: <reason>" and "Abandoned: <reason>". Owner ids and the approval's job id and hash no longer appear in the text; they stay structured on the reassignment and abandonment records. `workReassignActivitySummary` and `workAbandonActivitySummary` now take only the payload. Events already recorded keep their earlier text.
