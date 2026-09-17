---
"@knpkv/jcf-web": minor
---

Three things a week view needed to be usable on a real week.

**Write one block, not the whole day.** Clicking a proposable block on the calendar now offers that
stretch — `20:52–21:32`, its own forty minutes — with the row's other blocks one tick away in the
panel, and the amount following whatever is ticked. A confirmation names block _positions_ of a plan
the server still holds, never times or durations, so nothing a browser sends can widen a write.

The arithmetic that makes this safe is worth stating: a side is sized against the row's credit minus
what it already holds, and the selection only says how much of that room to use now. Sizing against
the selection instead would report "already logged" for the second block of any row whose first
block is in — it would read the morning's entry as evidence that the afternoon had been written too.
Written blocks are anchored to their own start, so accepting the evening stretch files it at 20:52
rather than after everything else the day holds.

**Issue titles, everywhere the key appears.** On the calendar block (last line, so a short block
loses the title rather than the times), in the confirm panel, and in every lane. Null means Jira
could not be asked, which is said out loud rather than shown as an untitled row.

**Only your own tickets are offered.** Hours on a ticket Jira assigns to somebody else move to an
_Assigned to somebody else_ lane: hours still visible, with the assignee, and an `It is mine` button
that records the exception in `~/.jcf/config.json` so it holds next week too. Nothing is withheld
when Jira could not answer, or on a Clockify-only week where Jira is out of scope entirely — the
header says which of those happened.
