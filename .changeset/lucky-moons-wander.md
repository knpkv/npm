---
"@knpkv/confluence-to-markdown": patch
---

Stop a single unpushable page from parking the whole workspace.

`sync push` held `origin/confluence` back after _any_ error, so one page that
could never succeed — deleted in the Confluence UI, say — blocked every later
push: the same failure was replayed each run, nothing new could be recorded, and
`sync pull` went on merging an ever-staler branch. `--force` was no escape, since
it only covers the round-trip refusal.

The two failure kinds are not equally recoverable, and the fix is to stop
treating them alike. A push failure is remembered by the file itself — `pushFile`
rewrites front-matter `contentHash` only after Confluence accepts the write — so
the branch can advance and the file is still picked up next run. A failed
deletion has no such record, because the local file is already gone, so only that
case holds the branch.

`push` therefore no longer short-circuits on "no unpushed commits" alone: a file
whose recorded hash still disagrees is pending work even when the branch has
moved on.
