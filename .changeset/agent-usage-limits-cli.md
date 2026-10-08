---
"@knpkv/agent-usage": minor
---

`agent-usage limits` prints this Machine's latest limits from the running server as one JSON line. Balances and spend stay on the authenticated page. It asks over the owner-only control socket, so another program on the same account (hostd, for Connect) can read them without a session cookie or a provider credential.
