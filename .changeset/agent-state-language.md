---
"@knpkv/herdr-connect": minor
"@knpkv/herdr-approvals": patch
---

Connect's agents now speak the hub's state language. Each directory row shows the agent's state as an icon and word in its tone, the same label the hub's Agent activity uses, instead of a plain capitalised word. Only working agents spin, and only with motion allowed. `waiting` now counts under the Status filter's "Needs you" (renamed from "Attention") rather than "Ready", because it waits on a person. Unknown states keep their own word with a caution alert icon, so they never look idle. `@knpkv/herdr-connect/surface` exports `agentStatePresentation`, `AgentStateLabel`, `agentBuckets`, `agentBucketLabel` and `agentBucketWorkPrefix`. herdr-approvals' Agent activity reads the same mapping, so its state words are now capitalised and blocked and errored agents show in critical tone.
