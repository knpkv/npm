---
"@knpkv/clockify-api-client": major
---

Update the generated Clockify API client from the latest OpenAPI specification.

Release: major (9 breaking, 1 addition).

Breaking:

- reference changed from #/components/schemas/RateDtoV1 to #/components/schemas/CostRateDtoV1 at `#/components/schemas/MembershipDtoV1/properties/costRate`
- reference changed from #/components/schemas/RateDtoV1 to #/components/schemas/CostRateDtoV1 at `#/components/schemas/ProjectDtoImplV1/properties/costRate`
- reference changed from #/components/schemas/RateDtoV1 to #/components/schemas/HourlyRateDtoV1 at `#/components/schemas/ProjectDtoImplV1/properties/hourlyRate`
- reference changed from #/components/schemas/RateDtoV1 to #/components/schemas/CostRateDtoV1 at `#/components/schemas/ProjectDtoV1/properties/costRate`
- reference changed from #/components/schemas/RateDtoV1 to #/components/schemas/HourlyRateDtoV1 at `#/components/schemas/ProjectDtoV1/properties/hourlyRate`
- reference changed from #/components/schemas/RateDtoV1 to #/components/schemas/CostRateDtoV1 at `#/components/schemas/TaskDtoV1/properties/costRate`
- reference changed from #/components/schemas/RateDtoV1 to #/components/schemas/HourlyRateDtoV1 at `#/components/schemas/TaskDtoV1/properties/hourlyRate`
- reference changed from #/components/schemas/RateDtoV1 to #/components/schemas/CostRateDtoV1 at `#/components/schemas/TimeEntryWithRatesDtoV1/properties/costRate`
- reference changed from #/components/schemas/RateDtoV1 to #/components/schemas/HourlyRateDtoV1 at `#/components/schemas/TimeEntryWithRatesDtoV1/properties/hourlyRate`

Additions:

- added schema CostRateDtoV1 at `#/components/schemas`
