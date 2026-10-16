---
"@knpkv/herdr-fleet": minor
"@knpkv/herdr-hub": patch
---

Refuse delegated jobs whose repository is not an absolute path with `FleetRepositoryNotAbsoluteError`, and fail only the job whose restart recovery fails so hostd keeps starting.
