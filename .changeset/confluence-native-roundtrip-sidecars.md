---
"@knpkv/confluence-to-markdown": patch
---

Preserve Confluence-native ADF elements through markdown sync by storing decoded
placeholder metadata in per-page `.adf.json` sidecars and hydrating those refs
before push.

The integration test now requires API auth for raw ADF verification, asserts the
sidecar file contract, and checks native node and mark metadata across the
create/update/reclone cycle.
