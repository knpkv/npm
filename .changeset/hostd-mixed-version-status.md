---
"@knpkv/herdr-hub": patch
---

`fleetctl status HOST` reads a host on an older hostd, whose status still has flat `branch`, `revision` and `dirty` fields. A Herdr spawn that fails because hostd's working directory is missing is no longer reported as "Herdr isn't installed". The not-running card's body says "Start Herdr, then retry.", matching its Retry button.
