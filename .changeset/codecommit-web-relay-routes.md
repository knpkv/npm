---
"@knpkv/codecommit-web": minor
---

CodeCommit web mounts the Relay harness under `/api/relay`: an event stream for the dock that re-checks the owner session every 15 seconds, routes to send, cancel and confirm, and backend status. A second server on the same home starts without Relay and says why, and Relay's comments go through the same permission prompt and audit log as review findings. A decision applies only to the session it was raised in, and an event stream that fails ends with `StreamFailed` instead of closing silently.
