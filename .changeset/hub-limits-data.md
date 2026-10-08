---
"@knpkv/herdr-fleet": minor
"@knpkv/herdr-approvals": minor
---

hostd reports Claude and Codex subscription limits. Set the optional `agentLimitsCommand` in the fleet configuration to an `agent-limits --json` command. `GET /v1/limits` then returns this host's read, and on the hub every peer's read too. A host that can't read its limits says why instead of reporting zero.
