---
"@knpkv/clockify-api-client": minor
---

Type Clockify custom-field values as any JSON value. The upstream spec declares them as objects, which Effect 4.0.0's generator turns into records that reject the strings, numbers, and arrays Clockify actually sends.
