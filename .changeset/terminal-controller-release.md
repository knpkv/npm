---
"@knpkv/herdr-hub": patch
---

Release terminal controller locks and connection slots after failed setup or a disconnected session, with a ten-second cleanup wait. Keep late finalizers owned by the hub, warn with only the host, agent ID and elapsed time, and preserve live-controller exclusivity and the four-controller limit.
