---
"@knpkv/relay-product": minor
---

Adds `RelayConversationPanel` to `@knpkv/relay-product/client`: one Relay conversation in rly's panel for any `ObjectRef`, with its transcript, confirmation cards and composer. The host owns opening and the summon. `relayTranscriptItems` lays a conversation out in the order it happened: tool work after the message it followed, and every run's end (finished, cancelled, failed) as its own item, so each is announced once. The fold now records where each tool call happened and how each run ended (`RelayToolRow.after`, `RelayConversationState.outcomes`), and a call that finishes without starting gets a row too.
