---
"@knpkv/agent-usage": minor
---

New `@knpkv/agent-usage/usage` entry, with `@knpkv/agent-usage/usage.css`. It exports the page's two charts, `UsageChart` and `LimitChart`, so another browser surface can draw them. `stackSeries` stacks any named series per period, and `UsageChart` now takes `periods` instead of a whole usage report, so a caller can chart tokens without cost. The entry bundles for a browser without the server, the store or Node modules.
