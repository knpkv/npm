---
"@knpkv/codecommit-core": minor
---

Add a bounded, strict read-only projection of existing owner comment snapshots, with exact target selection and cached timestamps.
Legacy comment rows are adopted only for the exact cached PR; requests for another repository or region no longer inherit that row.
