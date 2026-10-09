---
"@knpkv/agent-usage": minor
---

New `agent-usage usage [--range 24h|7d|30d] [--time-zone ZONE]`. It asks the running server for this Machine's tokens per period, agent and model, and its limit series over the range, and prints them as one JSON line (`UsageNow`, versioned). No cost, balance, Booking, session or path is in the answer, so another program (the herdr hub) may carry it across hosts. `@knpkv/agent-usage/usage` now exports `TokenUsageChart`, whose props have no `measure`, in place of `UsageChart`, and the chart's accessible `label` is required.
