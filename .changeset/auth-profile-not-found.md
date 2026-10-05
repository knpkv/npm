---
"@knpkv/atlassian-common": minor
"@knpkv/jira-cli": patch
"@knpkv/confluence-to-markdown": patch
---

`auth use <profile>` and `auth remove <profile>` now fail with a typed `ProfileNotFoundError` (exported from `@knpkv/atlassian-common/cli-auth`) and exit non-zero when no stored profile matches. The failure names the profile (`Profile not found: <profile>`, on stderr through each CLI's error handler); previously the line went to stdout and the command exited 0, so a script could not tell a typo from a switch.
