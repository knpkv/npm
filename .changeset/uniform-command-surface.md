---
"@knpkv/confluence-to-markdown": major
"@knpkv/jira-cli": major
"@knpkv/jira-clockify": major
"@knpkv/agent-skills": patch
---

Refactor CLI command surfaces around resource-first groups and remove the legacy top-level aliases.

- Jira issue reads now live under `jira issue get` and `jira issue search`; version reads and writes use `jira version get`, `jira version update`, and `jira version related-work`.
- Confluence workspace setup now uses `confluence workspace clone`, page operations use `confluence page`, and sync/git-backed operations use `confluence sync`.
- JCF timer operations now use `jcf timer`, ticket listing uses `jcf issue list`, and reconciliation uses `jcf sync reconcile`.
- Agent skills and product-local skill copies now document the same canonical commands.
