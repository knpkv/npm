---
"@knpkv/alchemy-console": minor
---

Local discovery no longer fails the whole walk on one bad entry. Symlinks that leave the search root are skipped (never followed), and dangling ones too, since they lead nowhere. Any other entry that can't be read is counted and skipped, so the projects that were found are still read. `discoverProjects` now returns `{ projects, unreadable }`. A walk that skipped unreadable entries reports one `local: io` discovery issue next to its stacks; only an unreadable root still fails.
