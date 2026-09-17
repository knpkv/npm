---
"@knpkv/clockify-api-client": major
---

Update the generated Clockify API client from the latest OpenAPI specification and decode workspace feature plans as objects.

Breaking: the published `./generated` entry point removes upstream models including `AmountDto`, `AttendanceDto`, `BalanceDtoV1`, `SharedReportDtoV1`, and `TimeEntryDto`. Consumers importing generated models must update their imports and check the regenerated request and response schemas before upgrading.
