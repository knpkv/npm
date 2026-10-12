---
"@knpkv/herdr-connect": patch
---

Restore the Connect directory after a stable agent moves panes. A strictly newer trusted inventory observation can update its pane while preserving the same parent and relation, in the existing batch transaction. Keep stale, equal-time and durable observations from moving ownership, and log local inventory failures with only a step, validated agent ID and reason.
