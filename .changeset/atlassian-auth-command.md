---
"@knpkv/atlassian-common": minor
"@knpkv/jira-cli": minor
"@knpkv/confluence-to-markdown": minor
"@knpkv/agent-skills": patch
---

One shared `auth` command group for jira and confluence: `makeAuthCommand(service, descriptor, options)` in `@knpkv/atlassian-common/cli-auth`. Each CLI exports one descriptor (`jiraCliDescriptor`, `confluenceCliDescriptor`: command name, product name, login scopes) that feeds both its auth and its `auth` commands.

- `jira auth create` lists every scope `jira auth login` requests. It previously listed three of five (missing `write:jira-work` and `manage:jira-project`), so an app set up from its instructions could not log in.
- `jira auth manage` is new: it opens the developer console with the scope and callback checklist.
- `confluence auth profiles`, `auth use <profile>` and `auth remove <profile>` are new; the docs already described them.
- `confluence auth status` prints the active profile, account, site and profile ID.
- `auth create` and `auth manage` print the URL first and exit non-zero when no browser opens (jira's `create` used to ignore that).
