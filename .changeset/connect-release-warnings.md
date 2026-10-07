---
"@knpkv/herdr-connect": patch
---

When a terminal session ends and herdr does not take the release command, does not exit, or cannot be killed afterwards, Connect now logs a warning for each instead of dropping the failure silently. Cleanup still never fails the session.
