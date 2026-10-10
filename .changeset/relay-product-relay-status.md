---
"@knpkv/relay-product": minor
---

`@knpkv/relay-product/client` gains Relay's status for a conversation: `useRelayStatus(conversations, ref, panelOpen)` and the pure `relayStatusOf` give the mark's activity (idle, working, attention, unread) and fixed status words ("Reading…" with the running tool's own summary, "Answering…", "Sending…", "Relay needs you", "Relay replied", "Sign in to Codex", "Relay hit an error", "Relay status unknown"). It reads the client's folded state, so a reconnect restores the status without replaying anything, and it never shows reply, message, failure or action text.
