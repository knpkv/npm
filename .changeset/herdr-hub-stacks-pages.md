---
"@knpkv/herdr-hub": minor
---

Add the Stacks module to the hub: `#stacks/overview` lists the credential host's alchemy stacks grouped by app, with resource counts and each stage's latest CI-published plan, and `#stacks/stack` shows one stage's activity and its resources, state, outputs and plan. Read-only; it is served only by the hub named in `RELAY_STACKS_HOST` and says why it is unavailable anywhere else. Last apply, drift and approval gates read "Not checked yet" for now.
