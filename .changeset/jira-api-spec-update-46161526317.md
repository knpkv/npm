---
"@knpkv/jira-api-client": major
"@knpkv/jira-cli": patch
"@knpkv/jira-clockify": patch
---

Update the generated Schema-backed Jira API client.

Release: major (3 breaking, 10 additions).

Breaking:

- removed property defaultValues at `#/components/schemas/CustomFieldContextDefaultValuesUpdate`
- added required property contexts at `#/components/schemas/CustomFieldContextDefaultValuesUpdate`
- removed property contextId at `#/components/schemas/IssueTypeDefaultValueUpdate`

Additions:

- added schema ContextDefaultValueUpdate at `#/components/schemas`
- added enum member AnySprintDates at `#/components/schemas/CreateSchedulingRequest/properties/inferredDates`
- added enum member AnySprintDates at `#/components/schemas/GetSchedulingResponse/properties/inferredDates`
- added property operation at `#/components/schemas/IssueTypeDefaultValueUpdate`
- added response 400 at `#/paths/~1rest~1api~13~1field~1{fieldId}~1context~1defaultValues/get`
- added query parameter preferFieldAssociatedErrors at `#/paths/~1rest~1api~13~1issue/post`
- added query parameter preferFieldAssociatedErrors at `#/paths/~1rest~1api~13~1issue~1{issueIdOrKey}~1transitions/post`
- added response 413 at `#/paths/~1rest~1api~13~1issue~1{issueIdOrKey}~1votes/post`
- added query parameter maxResults at `#/paths/~1rest~1api~13~1jql~1autocompletedata~1suggestions/get`
- added response 422 at `#/paths/~1rest~1api~13~1project-template/post`
