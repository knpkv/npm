---
"@knpkv/jira-clockify": patch
---

Only one `jcf watch` writes at a time. Subtracting what Clockify and Jira already hold makes a
_later_ look safe and says nothing about a _simultaneous_ one: two processes can derive the same gap
before either writes it, and an accidental second terminal is enough to double a day. A watch now
takes a lease in the config directory and refreshes it on every look; a second one says who has been
running since when and stops. The lease is a timestamp rather than a pid file, so a watch that is
killed outright blocks the next one for a few minutes instead of forever.

Write a settled block when the command says it will. The block already ran one Idle Cap past its
last prompt, and the deadline added another — so a block promised after six quiet minutes was
withheld for eleven. The bound is still exact: a later prompt can only extend a block by landing
within an Idle Cap of the last one, which is before the block's own end.

A restart no longer drops the block it was holding. The window opens one settle period before the
run starts — the stretch nothing could have written yet — so an interrupted tail is recovered
instead of lost. Work older than that window stays `jcf sync reconcile`'s, which shows the rows
before writing them.

End a stretch's presence where the next one begins. A session that switches branch gave its old
stretch a full Idle Cap of tail, which ran into the new branch's work and was shared back onto the
old Issue Key — so a switch a minute in put those minutes on both keys at once. The boundary line's
text also belonged to the wrong side of the switch, and a stretch with no typed prompt leaked its
text into the next one, which could carry evidence out of a directory that was never opted in.
