---
"@knpkv/herdr-hub": patch
"@knpkv/herdr-connect": minor
---

Report the text field, actual length and kind-specific limit when Relay posts are too long. CLI and HTTP validation share the same errors and reject empty or whitespace-only text while accepting URLs within the limit.

Export shared Connect post text limits and reject blank text only in the published posting schemas. Historical whitespace-only reports and last words stay readable. Hub validation uses the published schemas as its authority.
