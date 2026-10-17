---
"@knpkv/alchemy-console": minor
---

Add `./host` and `./host/server` exports so another server, such as a Relay Hub module, can serve the stacks read model. `./host` has the tagged result contracts (`StacksOverviewResult`, `StackDetailResult`, `StackPlanResult`, `StacksUnavailable`) and the `StackQuery` selector. `./host/server` has `stacksHostLayer`, the same discovery, SSO and plan reader the standalone console runs, `stacksHostOptions` for its paths, and `makeStacksHostReads`, which returns a failed discovery as a result rather than an error.
