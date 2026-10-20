---
"@knpkv/alchemy-console": patch
"@knpkv/rly": minor
"@knpkv/review": patch
---

IconButton has an inline size: a 28px box, a 16px icon, and the shared 44px hit area. It stays 28px on a coarse pointer. CommitLabel and the plan id buttons use that size and no longer set their own box. A successful copy says Copied in a polite live region for about 2 seconds, and the button shows a check in the same box. The id stays out of that text.
