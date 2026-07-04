---
"@knpkv/confluence-to-markdown": major
---

Stop importing legacy Confluence OAuth tokens from `~/.confluence/auth.json`.

Existing users with only the legacy token file must run `confluence auth login` again so credentials are stored as shared Atlassian auth profiles under `~/.config/atlassian/confluence-to-markdown/`. Legacy `~/.confluence/config.json` OAuth client configuration is still migrated.
