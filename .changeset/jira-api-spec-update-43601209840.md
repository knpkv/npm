---
"@knpkv/jira-api-client": minor
"@knpkv/jira-cli": patch
"@knpkv/jira-clockify": patch
---

Update the generated Schema-backed Jira API client.

Release: minor (0 breaking, 3 additions).

Additions:

- added enum member AnySprintDates at `#/components/schemas/CreateSchedulingRequest/properties/inferredDates`
- added enum member AnySprintDates at `#/components/schemas/GetSchedulingResponse/properties/inferredDates`
- added query parameter maxResults at `#/paths/~1rest~1api~13~1jql~1autocompletedata~1suggestions/get`
