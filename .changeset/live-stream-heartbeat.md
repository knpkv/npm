---
"@knpkv/control-center": minor
---

Overview's live updates no longer disconnect after a keepalive, so changes appear immediately instead of after a growing reconnect delay. Connection summaries now expose an optional runtime revision so live refreshes reload only the connection details that changed.

An update already being read finishes before a normally closed live stream reconnects. Services retries unavailable connection details on the next refresh and shows completed syncs in other open clients.
