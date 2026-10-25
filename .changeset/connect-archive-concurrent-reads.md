---
"@knpkv/herdr-connect": patch
---

Two Connect clients reading the agent directory at the same moment no longer delay the archive. The read that finds the other one writing the same host's observation now skips that host quietly. It used to log "Connect archive observation failed" and reset the host's absence count, so with several clients open, closed agents reached Archived late. A read blocked by anything else still fails and resets as before.
