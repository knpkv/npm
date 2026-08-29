---
"@knpkv/codecommit": minor
---

Add `codecommit pr open`, which resolves the open PR for the branch checked out
in a working directory and opens its console page.

The remote names the repository and usually the region; the AWS profile is not
guessed but resolved by scanning the enabled accounts for the one that holds the
matching PR. `--json` and `--url` print the resolution instead of opening it.

Adds `collectOpen` to the exported `FilterServiceContract` — the preset-free
counterpart to `collect`, narrowed only by repo/author — and exports
`codecommitPullRequestConsoleUrl`, a partition-aware PR console link builder.
