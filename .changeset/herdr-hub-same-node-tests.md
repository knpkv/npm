---
"@knpkv/herdr-hub": patch
---

Pin that only the hub's own tailnet node, calling the hub server itself, is treated as a viewer on the hub machine: a hub-node WhoIs on another server, or another node on the hub, gets no Code owner UI link. The WhoIs-to-caller mapping is now one internal function shared by the listener and its tests.
