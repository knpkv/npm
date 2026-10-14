---
"@knpkv/clockify-api-client": major
---

Regenerate the Clockify client from the current specification while retaining published models that no endpoint references. Preserve struct types without JSON index signatures. Binary multipart request fields now accept Blob or File, and open custom-field values use JSON types. These generated contract corrections require a major version; the legacy string-valued expense model exports remain available.
