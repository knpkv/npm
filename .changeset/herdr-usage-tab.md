---
"@knpkv/herdr-connect": minor
"@knpkv/herdr-approvals": minor
---

The hub has a Usage tab beside Approvals, Connect and Work (`g` then `u`, `?tab=usage`). It shows each host's "Limits now" cards, the fleet's tokens per day or hour stacked by agent and model, and each host's limits over the range, with a 24h/7d/30d switch on every screen size that defaults to 7 days and is remembered in the browser. On the hub's own machine it links to agent-usage's full page. Connect keeps its one-line limits strip, which now links to the Usage tab instead of opening the per-host cards. herdr-connect exports the tab as `@knpkv/herdr-connect/usage` (`UsageSurface`, `makeUsageAtoms`). The hub now passes on a peer's unavailable detail only when it is one of hostd's fixed sentences, so an older peer cannot relay raw agent-usage stderr through it.
