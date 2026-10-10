---
"@knpkv/herdr-approvals": patch
---

`fleetctl work snapshot` reads a newer hub's snapshot: keys it doesn't know are dropped instead of failing the read, and only the known shape is printed. Checkpoints sent to a hub are still decoded strictly.
