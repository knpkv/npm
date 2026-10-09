---
"@knpkv/herdr-connect": minor
"@knpkv/herdr-approvals": minor
---

The hub serves usage history for the Usage tab. hostd answers `GET /v1/connect/usage?range=24h|7d|30d&timeZone=<zone>` with each host's `agent-usage usage` read, which holds tokens per period, agent and model, and the limit series. It derives that command from the existing `agentUsageLimitsCommand`. On the hub the answer includes every peer's read, from the peer's tailnet `/v1/connect/usage/local`. A bad range or zone is refused with 400 before anything runs, and reads are cached per range and zone for five minutes. herdr-connect exports the `FleetUsage` schemas, a tolerant decoder that skips token cells and limit series from a newer agent-usage and counts them, and `hubUsage`/`fleetUsage`. Limits and usage now share one fan-out helper.
