---
"@knpkv/herdr-connect": patch
---

Share one five-second acquisition and SQL retry budget across relationship and activity writes in a local inventory. Reporter peers receive the exhausted operation's safe busy metadata before their transport deadline instead of losing it to repeated per-write budgets. Keep post-commit finalization outside the lock timeout and under the store permit.
