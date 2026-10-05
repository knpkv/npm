---
"@knpkv/jira-cli": patch
"@knpkv/confluence-to-markdown": patch
---

`JiraAuthService` and `ConfluenceAuthService` are now derived from atlassian-common's `AtlassianCliAuth` instead of re-spelling it, and `LoginOptions` / `AccessibleSite` are re-exported from there. The types are unchanged: a type-equality check against the previous hand-written interfaces passed before the switch. `ConfluenceAuthService` keeps its one real difference, a string access token and no `getSiteUrl`.
