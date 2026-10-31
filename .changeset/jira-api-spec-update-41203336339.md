---
"@knpkv/jira-api-client": major
"@knpkv/jira-cli": patch
"@knpkv/jira-clockify": patch
---

Update the generated Schema-backed Jira API client.

Release: major (1 breaking, 7 additions).

Breaking:

- removed response 404 at `#/paths/~1rest~1api~13~1projects~1fields/get`

Additions:

- added property nextPageCursor at `#/components/schemas/PolicySummaryResponse`
- added response 422 at `#/paths/~1rest~1api~13~1issuesecurityschemes/post`
- added response 422 at `#/paths/~1rest~1api~13~1permissionscheme/post`
- added query parameter cursor at `#/paths/~1rest~1api~13~1policies/get`
- added response 400 at `#/paths/~1rest~1api~13~1policies/get`
- added response 500 at `#/paths/~1rest~1api~13~1policies/get`
- added response 422 at `#/paths/~1rest~1api~13~1priority/post`
