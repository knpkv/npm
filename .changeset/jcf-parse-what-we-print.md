---
"@knpkv/jira-clockify": patch
---

`parseDuration` now reads back everything `formatDuration` writes: spaces between the parts, and a
trailing seconds component (`1h 30m`, `56m 36s`, `30s`).

The two had drifted into disagreement, and the place it showed was a form. A credited amount of
3396 seconds renders as `56m 36s`, which the parser rejected — so any row whose credit was not a
whole number of minutes arrived pre-filled with text its own validator refused, and could not be
accepted at all. Units still have to appear in order, so `1h30` and `30s 5m` stay malformed.
