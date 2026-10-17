---
"@knpkv/herdr-hub": minor
---

Add a read-only Stacks module to the Hub: the host's alchemy stacks, one stack's resources, state and outputs, and its latest published plan, using alchemy-console's own views. It is read on the host named by `RELAY_STACKS_HOST` only, and reports when it is not configured, configured for another host, or its reader can't start. Nothing in it applies, plans or approves.
