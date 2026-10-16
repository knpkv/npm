---
"@knpkv/control-center": patch
---

The connection card shows its test and last-sync times as readable UTC times ("14 Jul 2026, 10:00 UTC"), like the Overview's Sources panel. Before, it showed raw ISO text, and the last successful sync rendered as an internal `DateTime.Utc(…)` string. Both now sit in a `<time datetime>` element carrying the exact instant.
