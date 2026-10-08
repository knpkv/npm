---
"@knpkv/codecommit-core": minor
"@knpkv/codecommit-web": patch
---

First-run follow-ups. When more than one read waits for permission, the read bar names them ("2 reads are waiting: Get identity for dev and List PRs for dev"; three at most, then "and N more"), so "Allow every read" is plainly the one answer. `@knpkv/codecommit-core`: `PermissionGateLive.pendingOf(category, limit)` reports the prompts actually waiting in this process. Settings → Accounts says "Checking sign-in…" until an account's identity read answers, instead of "Not logged in" next to a live SSO profile, and a browser without a session gets the sign-in-link guidance in Settings instead of a pointer to the config file.
