---
"@knpkv/relay": patch
---

A failed run's `cause` is always one of Relay's own sentences, chosen by Pi's reason code (`model_error`, `no_model`, `reset`, anything else); the backend's message is never forwarded, because rly reads the cause aloud.
