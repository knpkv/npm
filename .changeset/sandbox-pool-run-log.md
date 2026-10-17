---
"@knpkv/sandbox-pool": minor
---

`resetAccount` records each run in a new `RunLog` service: a start, each step's start and end (with the blocker and the aws-nuke output tail), and the outcome. `summarizeRuns` folds the entries into one summary per run, and `makeMemoryRunLog` is an in-memory log. `SandboxStore` operations may now fail with `SandboxStoreUnavailable`, for durable stores; the memory store never does. `resetAccount` now requires `RunLog`.
