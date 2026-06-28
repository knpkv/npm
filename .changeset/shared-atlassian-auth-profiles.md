---
"@knpkv/atlassian-common": minor
"@knpkv/jira-cli": minor
"@knpkv/confluence-to-markdown": minor
"@knpkv/agent-skills": patch
"@knpkv/jira-clockify": patch
---

Add shared Atlassian auth profile storage for multi-account and multi-site OAuth use.

Jira and Confluence now expose `auth profiles`, `auth use <profile>`, and `auth remove <profile>` commands backed by shared profile management in `@knpkv/atlassian-common`. Confluence also migrates existing legacy auth/config files on first use. Agent skills and docs now describe the profile commands and active-profile checks.
