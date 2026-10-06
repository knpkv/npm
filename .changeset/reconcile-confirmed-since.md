---
"@knpkv/herdr-work": minor
---

`WorkService.reconcile` takes an optional `{ confirmedSince }`. With it, a goal is closed only from a pull request fact that was read again, successfully, at or after that time, so a caller that has just re-read its pull requests never acts on an older fact: the pull request may since have reopened, or the latest read may have been refused as stale. This covers superseded goals, which the snapshot hides. Without the option, a fact is still skipped when a failed read newer than its last confirmation has put it in doubt.
