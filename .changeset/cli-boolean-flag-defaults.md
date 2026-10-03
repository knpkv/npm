---
"@knpkv/confluence-to-markdown": patch
"@knpkv/jira-cli": patch
---

Keep boolean flags such as `--dry-run`, `--json`, and `--force` optional. Effect 4.0.0 made omitted boolean flags required, so each now defaults to `false`.
