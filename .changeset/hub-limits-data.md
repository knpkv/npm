---
"@knpkv/herdr-fleet": minor
"@knpkv/herdr-approvals": minor
"@knpkv/herdr-connect": minor
---

hostd serves Claude and Codex limits for Connect. Set the optional `agentUsageLimitsCommand` in the fleet configuration to `agent-usage limits`. `GET /v1/connect/limits` then returns this host's read, and on the hub every peer's read too. herdr-connect exports the wire schemas (`HostLimits`, `FleetLimits`) and the fleet collection. A host that can't read its limits says why instead of reporting zero.
