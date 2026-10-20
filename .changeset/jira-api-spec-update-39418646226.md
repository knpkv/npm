---
"@knpkv/jira-api-client": minor
"@knpkv/jira-cli": patch
"@knpkv/jira-clockify": patch
---

Update the generated Schema-backed Jira API client.

Release: minor (0 breaking, 6 additions).

Additions:

- added schema AuditEntry at `#/components/schemas`
- added schema AuditPage at `#/components/schemas`
- added schema AuditUser at `#/components/schemas`
- added schema AuditUserAvatarUrls at `#/components/schemas`
- added path /rest/api/3/invalid-jqls-access-log at `#/paths`
- added response 503 at `#/paths/~1rest~1api~13~1priority~1{id}/delete`
