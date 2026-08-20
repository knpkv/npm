---
"@knpkv/jira-clockify": patch
---

Read every page of Jira's worklog search. `jcf sync reconcile` asked for the first hundred issues and
ignored the continuation token, so in a window with more than that, a ticket that fell off page one
tallied as holding no Jira time at all — and since every caller subtracts this from what a session
accounts for, that reads as "Jira is short by the whole day". `jcf watch` would then post hours Jira
already had. A week with a hundred issues is ordinary. The read now follows the token, and fails the
run rather than proceeding on a partial tally.

Win the watch lease by creating the file, not by reading it. A read-then-write let two watches
starting together both conclude the lease was free; acquisition is now an exclusive create, so the
filesystem picks the winner. The lease also carries its holder's poll interval, so a contender
started with `--interval 1` can no longer declare a live hourly watch abandoned after three seconds.

Resume from the earliest _unresolved_ instant rather than from the shutdown time. A watch stopped
mid-block was holding prompts that had not settled; recording when it stopped and resuming from there
filtered out exactly those prompts, so the block it was protecting was lost anyway. The cursor now
records the oldest block still held.

And a resume no longer authorises back-dating. Taking `max(cursor, now − settleWindow)` meant any old
cursor resolved to `now − settleWindow`, so every restart wrote a fresh window of unreviewed work —
the forward-only boundary held only for the very first run. The lease decides whether a resume is
offered at all, and only when the previous holder stopped recently.

`jcf watch` also pointed at `jcf auth login` when Jira refused a worklog. That command does not
exist; the real one is `jcf auth jira login`, so following the instruction produced another error.

The `--agent` picker's header is bounded to the terminal width like its detail line already was. A
long Issue Key with unequal gaps passed eighty columns, and since the prompt counts only the title
lines it was handed, the terminal wrapped the surplus and every later row sat a line out of place
while the user was choosing what to write.

The `no-cli-runmain-default-error-reporting` rule now matches the options argument rather than
anything inside the call, so `runMain(makeProgram({ disableErrorReporting: true }), { teardown })` —
where reporting is still on — is caught.
