---
"@knpkv/herdr-hub": patch
---

Refuse browser WebSocket upgrades on the tailnet terminal endpoint. Only the hub's own relay dials `/v1/connect/terminal`, and it sends no `Origin`; an upgrade carrying an `Origin` or a cross-site `Sec-Fetch-Site` is now rejected before the Tailscale identity check, so a web page open on the hub node cannot drive a peer's terminal.
