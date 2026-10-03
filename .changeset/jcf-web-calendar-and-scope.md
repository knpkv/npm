---
"@knpkv/jcf-web": minor
"@knpkv/jira-clockify": minor
---

The week is a calendar. Hours down, days across, every block at the time it happened: logged entries
solid, proposable time dashed, overlapping work side by side the way a calendar shows it. Clicking a
dashed block confirms it; clicking empty space offers a manual entry at the time clicked. A table of
day totals could say how much, but only this can say when — and when is what a person checks a
proposal against.

That needed the engine to stop discarding what it already reads. `compare` walked each Clockify
entry's real interval and summed it away into day totals; `ReconcileRow.intervals` now carries those
intervals, labelled with the system that reported them, alongside the totals that remain
authoritative on how much.

Reconciliation can now be about one system. `compare` and `proposeFromSessions` take `sides`, and a
system that is out is not read, not proposed for, and not written to. That is stronger than skipping
its write: a side nobody read holds an unknown amount, and treating unknown as zero would propose the
whole day for it. In the browser it is a header choice — both, Jira only, Clockify only — remembered
per browser, and a Jira-only week makes no Clockify request at all.

Writes take `targets` to match, and `SideOutcome` gains `Skipped` so a system nobody asked about is
distinguishable from one that owed nothing. The gap on a skipped side is left exactly as it was, so
asking for Jira today and both tomorrow writes the Clockify half tomorrow.
