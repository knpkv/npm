---
"@knpkv/ai-codex": patch
"@knpkv/jira-clockify": patch
---

Start a Codex turn's timeout after prompt-only feature discovery, so a slow `codex features list` no longer eats into the turn's budget. JCF now reads Issue Keys from textual tool results as attribution evidence (never as presence), and agent reconcile no longer says both sides hold everything while withheld, unattributed or skipped time is still listed. Session Root and Standing Attribution prefixes now accept `~` only as `~` or `~/…`, and `jcf watch` names unplaced time again when a later session adds to the same day.
