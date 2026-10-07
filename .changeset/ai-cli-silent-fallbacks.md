---
"@knpkv/ai-claude": patch
"@knpkv/ai-codex": patch
---

Claude's output decoding falls back to line-delimited events only when the whole output isn't one result document, never on other failures. Codex logs a warning when it can't remove its temporary output-schema directory, instead of ignoring that silently.
