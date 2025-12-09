---
"@knpkv/confluence-to-markdown": minor
---

Add OAuth authentication for Confluence Cloud

- `confluence auth create` - opens Atlassian Developer Console to create OAuth app
- `confluence auth configure` - save client ID/secret
- `confluence auth login` - browser-based OAuth flow
- `confluence auth logout` - remove stored token
- Show login status in `confluence status`
- Auto-refresh tokens when expired
- Use granular scopes for API v2: read:page:confluence, write:page:confluence
