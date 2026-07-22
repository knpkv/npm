---
"@knpkv/clockify-api-client": patch
"@knpkv/jira-clockify": patch
---

Fix `jcf` commands failing to decode Clockify time-entry responses when optional
fields come back as explicit `null`:

- `jcf timer start` failed with `Expected string, got null at ["kioskId"]` —
  Clockify returns `kioskId`, `projectId`, and `taskId` as `null` (not absent).
- `jcf sync reconcile` failed with `Expected array, got null at [0]["tagIds"]` —
  Clockify returns `tagIds` as `null` for entries with no tags.

Patch the OpenAPI spec so those fields decode as nullable across the time-entry
response schemas (`TimeEntryDtoImplV1`, `TimeEntryDtoV1`,
`TimeEntryWithRatesDtoV1`) and regenerate the client.

Also stop `jcf timer start` from printing a misleading `Timer started` line
after the start actually failed.
