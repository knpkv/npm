---
"@knpkv/codecommit": minor
---

Add `--filter` preset option to `codecommit pr list` that fans out across all
enabled accounts in `~/.codecommit/config.json`. Presets: `mine` (PRs you
authored), `needs-my-review` (PRs awaiting your approval), `stale` (no activity
for >7d), `conflicting` (merge conflicts). Caller identity is resolved per
profile via `getCallerIdentity`. `--profile`/`--region` are ignored when
`--filter` is set; `--repo`/`--author`/`--json` still compose normally.
