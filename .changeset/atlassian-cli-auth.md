---
"@knpkv/atlassian-common": minor
"@knpkv/jira-cli": patch
"@knpkv/confluence-to-markdown": patch
---

`@knpkv/atlassian-common/cli-auth` now holds the browser login and rotating refresh-token flow that `jira` and `confluence` each carried a copy of; both CLIs bind it with `makeAtlassianCliAuth`. Login no longer gives up when no browser opens — it says so on stderr and keeps waiting, since the URL is already printed (`jira` used to treat a launcher that ran but failed as success; `confluence` aborted the login). `jira` login also reports the provider's error code when its description is empty, and reports callback-server failures as `OAuthError`.
