---
"@knpkv/atlassian-common": minor
"@knpkv/jira-cli": patch
"@knpkv/confluence-to-markdown": patch
---

`auth use <profile>` and `auth remove <profile>` now fail with a typed `ProfileNotFoundError` (exported from `@knpkv/atlassian-common/cli-auth`) and exit non-zero when no stored profile matches. They still print `Profile not found: <profile>`; previously they printed it and exited 0, so a script could not tell a typo from a switch.
