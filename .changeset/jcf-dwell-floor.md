---
"@knpkv/jira-clockify": minor
---

Ownership of the timeline now changes no more often than the Dwell Floor — fifteen minutes by
default, `jcf config set dwell <seconds>`, zero to turn it off.

Three concurrent sessions on three Issue Keys interleave their prompts, and read literally that says
the work changed ticket every few minutes. It did not: it is an artefact of reading several
transcripts at once. A day of it is two dozen slivers on a calendar and indefensible on a timesheet.
`applyDwellFloor` reassigns any stretch shorter than the floor to the neighbour it touches,
preferring the incumbent — the ticket that was already holding that time before the interruption.

It reassigns time and never creates or drops any, so the inequality that makes a proposal safe to
accept survives intact. Three rules bound it:

- A short stretch is **not** absorbed when that would turn hours nothing placed into hours credited
  to an Issue Key. Demoting an attributed sliver into unplaced time is safe — nothing gets written —
  but the reverse would bill work no transcript placed there.
- A stretch with no neighbour keeps its own time, however brief. Four minutes alone in the evening
  has no incumbent to belong to, and dropping it would lose work that happened.
- Nothing is ever welded across a local midnight, because runs are bucketed by the day they start
  in.

The credited spans on a proposal now come from the same coalesced timeline as its seconds, so a
row's blocks and its total can no longer tell different stories.
