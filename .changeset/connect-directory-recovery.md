---
"@knpkv/herdr-connect": minor
"@knpkv/herdr-hub": minor
---

Add optional configured `hosts` to fleet directory responses and `configuredHosts` to the directory view. Empty directories keep search and filters, and name configured hosts when supplied by the hub. Older responses remain supported without the hint.

Remember missing parents' display names through optional relationship `parentName` and archive name lookup, without treating those names as live identity. Keep a lone orphan's alert inline, while siblings share one missing-parent notice. Retain typed unavailable readings in `ConnectLimitsView.problems` for limits warnings.

Keep live directory rows available when archive name enrichment fails, with a warning in the server log. Keep disabled limits hidden after refresh failures, and identify an unavailable host when other host readings are present.

Match directory recovery, empty filters, orphan groups and pinned agents to the current design. Use commas in directory copy, 48px HTTP recovery and clear-search controls, compact timeout and scoped filter controls with 44px hit areas, and sticky pins with reserved footer space that leaves agent rows and footer actions clear. Cap phone pin pills at 144px and truncate only names, keeping state words visible with 12px end padding. Give directory reads a typed ten-second deadline and distinguish actual timeouts from HTTP, network and decoding failures; omit the Usage link for a generic limits request failure. Match secondary metadata, regular body text and inset family dividers. Keep the limits footer hidden until the first directory loads, while preserving it with retained stale rows.
