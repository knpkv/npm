---
"@knpkv/control-center": minor
---

Overview's live updates no longer disconnect after a keepalive, so changes appear immediately instead of after a growing reconnect delay. Connection summaries now expose an optional runtime revision so live refreshes reload only the connection details that changed.
