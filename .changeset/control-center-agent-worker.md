---
"@knpkv/control-center": minor
"@knpkv/ai-runtime": patch
---

Add a provider-neutral durable agent worker that claims one release job, persists validated runtime events and terminal failures, and completes recovered cancellations without relaunching a provider. Make the first validated terminal runtime event authoritative so never-ending provider transports are interrupted promptly.
