---
"@knpkv/agent-usage": minor
---

The server answers one Booking's sessions in a range at `/api/sessions`: each session's first and last request, requests, tokens and API-equivalent cost on that Booking, most cost first, capped at 200 rows with a count of the rest. Same owner-session and origin checks as every read.
