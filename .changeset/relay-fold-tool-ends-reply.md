---
"@knpkv/relay-product": patch
---

A tool call ends the reply streaming before it, so text before and after the call are separate replies. That is how Pi stores them, so a reconnect's Snapshot no longer regroups the transcript or counts a reply the reader already saw as new.
