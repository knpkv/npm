---
"@knpkv/agent-usage": patch
"@knpkv/herdr-monitor": patch
---

Failures that were silently swallowed now say so. agent-usage's page reports a successful reply it cannot read instead of treating it as empty, and logs a failed control-socket exchange. herdr-monitor answers a publish that stalls past its deadline with 408 rather than 400, and logs every failed publish request.
