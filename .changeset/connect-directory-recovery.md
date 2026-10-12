---
"@knpkv/herdr-connect": minor
"@knpkv/herdr-hub": minor
---

Add optional configured `hosts` to fleet directory responses and `configuredHosts` to the directory view. Empty directories keep search and filters, and name configured hosts when supplied by the hub. Older responses remain supported without the hint.

Remember missing parents' display names through optional relationship `parentName` and archive name lookup, without treating those names as live identity. Keep a lone orphan's alert inline, while siblings share one missing-parent notice. Retain typed unavailable readings in `ConnectLimitsView.problems` for limits warnings.

Match directory recovery, empty filters, orphan groups and pinned agents to the current design. Use commas in directory copy, compact recovery controls with 44px hit areas, and footer-anchored pins that leave agent rows clear. Match secondary metadata, regular body text and inset family dividers. Keep the limits footer hidden until the first directory loads, while preserving it with retained stale rows.
