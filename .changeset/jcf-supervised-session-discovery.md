---
"@knpkv/clockify-api-client": major
"@knpkv/jira-clockify": minor
"@knpkv/jcf-web": minor
---

Discover every worked ticket from Claude Code and Codex sessions.

Presence is now a supervised turn: a typed prompt, including one queued while the agent was busy, opens a turn and the agent's work inside it counts until the turn ends, a task notification or auto-continuation takes over, or the idle cap passes. Task notifications, auto-continuations and `isMeta` lines no longer count as typed. Legacy Codex tool-call response items keep a turn alive. `decodeTranscript` now requires `idleCapMs`; `decodeSessionLines` and `SessionLine` are new.

Parallel stretches no longer drop tickets: every attributed ticket keeps a share, overlapping short tickets stay co-owners, and the web calendar shows suggestions down to Jira's one-minute minimum. When minutes are scarce, open-sprint tickets assigned to you rank first, then tickets not yet logged that day; the same facts appear as tie-breakers in the attribution prompt. Inside one unbroken stretch each ticket now gets a single block, ordered by first activity and packed with no gaps; a ticket that cannot reach a minute folds into the one ranked above it.

Ignore a ticket in every week with `jcf config set session-ignore <KEY>` or the web's Ignore button, and restore it from the Ignored tickets list. An ignored ticket is never suggested or offered to the attribution agent; a branch or path match to it falls through to the session's other candidates, and its parallel time goes to the tickets it ran alongside. Reports carry its raw time as `ignored`. In the web calendar, back-to-back short suggestions show as one card per stretch, and the page uses the full window width.

An orchestrating session nothing else places is split across the open-sprint tickets it mentions, by mention count, per active stretch (new attribution signal `split`); deterministic reads such as `jcf watch` leave it unplaced. The web lists low-confidence matches with a "Log as" action, and saved entries can be deleted or moved to another ticket; a delete releases its session claim so the time is suggested again, and a move carries the claim to the replacement. `SavedEntries` gains `remove` and an optional `ticketKey` on update.

Quick approvals are confirmed in batches of up to fifty under one provider re-read (new `/api/rows/confirm-batch`), Jira worklogs are read eight issues at a time, and idempotent Jira reads retry a dropped connection twice, so a long queue no longer waits on one full re-read per approval.

A provider window that needs manual review no longer fails a read: proposals carry a per-provider `writeBlocked` hold, the web shows the hold and disables writes to held providers, and writes keep refusing.

Ticket moves persist a replacement intent before creating provider time. Uncertain or partial moves stay held across restart and cannot create another replacement on retry; a verified pair can be resolved by explicitly deleting either entry. Ordinary replacements retain their verified ID and start so extending a reviewed window does not mistake the move for unknown earlier time. The private source ledger upgrades to version 5 while retaining existing claims and holds.

Breaking (`@knpkv/clockify-api-client`): `TimeEntryWithRatesDtoV1.costRate` and `hourlyRate` are now `RateDtoV1 | null`, matching the live API, which returns `null` when no rate applies.
