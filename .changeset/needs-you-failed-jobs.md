---
"@knpkv/herdr-hub": minor
---

The Needs-you read now also returns the fleet's failed and interrupted jobs from the last 7 days, across every host, newest first, at most 20. Each one carries its host, kind, who asked, why it failed in plain words, and whether a person had approved it. A job retried later on the same host with the same request, which then succeeded, drops out. The failures travel in a new `failures` list beside `items`, so pages built before it still read the response. Each contribution also reports `lastDecisionAt`, the newest approval or rejection in that week. Nothing on screen changes yet.
