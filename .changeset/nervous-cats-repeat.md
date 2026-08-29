---
"@knpkv/codecommit": minor
"@knpkv/codecommit-core": minor
---

Add `codecommit pr open`, which resolves the open PR for the branch checked out
in a working directory and opens its console page.

The remote names the repository and usually the region. An embedded
git-remote-codecommit profile narrows the scan; otherwise ambiguous matches
across accounts and incomplete scans are rejected. Regionless helper remotes
must resolve to one configured region. Exact-repository fetching avoids losing
the result to an unrelated repository failure, and repository absence is
treated as a conclusive empty result. `--json` and `--url` print the
resolution instead of opening it.

Adds `collectOpen` to the exported `FilterServiceContract` — the preset-free
counterpart to `collect`, narrowed only by repo/author — and exports
`codecommitPullRequestConsoleUrl`, a partition-aware PR console link builder.
`AwsClient.getPullRequests` now accepts an optional exact repository name.
