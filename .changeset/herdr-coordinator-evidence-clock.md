---
"@knpkv/herdr-coordinator": patch
---

`pullRequestEvidenceLayer` no longer lists `Clock` among its requirements. Effect's clock is a default reference, so the declared requirement could never be satisfied at the type level, and callers had to silence the diagnostic.
