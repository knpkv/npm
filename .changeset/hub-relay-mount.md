---
"@knpkv/herdr-approvals": minor
---

The hub mounts Relay, read-only. The canonical listener serves `/v1/relay/*` for one fleet conversation, checking identity, origin and the conversation before Relay starts. Relay reads the fleet's agents, the pending approvals, one job's state and the work board, each answer capped in items and bytes, and cannot approve, decline, prompt or submit. hostd loads Relay on the first request, so a broken install or a store another hostd holds answers 503 with the fix and never stops the hub; the next request retries. Sessions live in `<stateDirectory>/relay/sessions.sqlite`. New server option: `relay: { directory, backends? }`.
