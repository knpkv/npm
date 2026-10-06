---
"@knpkv/clockify-api-client": minor
"@knpkv/jira-clockify": minor
---

`jcf auth clockify setup` reported "No workspaces found." and saved nothing, even when the key had workspaces. The generated client could not decode a real `/v1/workspaces` response, and setup turned that failure into an empty list.

- **`@knpkv/clockify-api-client`**: `WorkspaceDtoV1` now matches what the API returns.
  - `featureSubscriptionType` is a `string` (e.g. `FREE_2026`), not a `FeaturePlan` object.
  - `features` is a `ReadonlyArray<string>`.
  - `workspaceSettings` is no longer modelled, because the upstream schema disagrees with live responses on many nullable and enum fields.
  - `MembershipDtoV1.costRate` and `hourlyRate`, and `WorkspaceSubdomainDtoV1.name`, accept `null`.
  - `FeaturePlan` and `WorkspaceSettingsDtoV1` stay exported.
  - These are type changes to exported generated schemas. The previous types could not decode a real response, so code relying on them could not have run.
- **`@knpkv/jira-clockify`**: setup now fails with a typed `ClockifyRequestError` that names the failed request, instead of reporting no workspaces. "Invalid API key" is reported only when Clockify rejects the key with 401 or 403; before, any failure looked up the user as an invalid key. The account lookup is exported as `loadClockifyAccount`, so it can be tested against real-shaped responses.
