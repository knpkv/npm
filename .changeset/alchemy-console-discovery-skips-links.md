---
"@knpkv/alchemy-console": minor
---

Local discovery no longer fails the whole walk on one bad entry. Symlinks that leave the search root are skipped (never followed), and dangling ones too, since they lead nowhere. Any other entry that can't be read is counted and skipped, so the projects that were found are still read. `discoverProjects` now returns `{ projects, unreadable }`. A walk that skipped unreadable entries reports one `local: skipped` discovery issue next to its stacks; only an unreadable root still fails.

Such a partial walk is reported as a new `local: skipped` discovery issue (`DiscoveryIssue.reason` gains `"skipped"`), kept distinct from `local: io`, which now means the root or a project's state couldn't be read. S3 discovery reports at most one issue per profile and reason, so an expired profile with several buckets is one sign-in issue, not one per bucket.
