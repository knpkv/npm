---
"@knpkv/herdr-connect": minor
"@knpkv/herdr-approvals": minor
---

Connect is now the hub's one agent list, and the Work tab no longer repeats agents under Agent activity. Each Connect row leads with the agent's state (icon and word) in a fixed column, then its name and work, then when it was last active. Lineage indents the name, not the state. At 24rem and below the state sits above the name. A row's accessible name is its own content plus "open terminal". Status filter options show their counts within the current Host filter, ignoring the search. A host that didn't answer is named in the Host filter (not offered as an option) and in a line above the list with its cause: "GAMMA (timed out) didn't answer; its agents aren't listed." That line now shows on phones too. The directory shows when it was last read ("Updated 09:41:05"), changing only when a poll lands, and says "Stale" when a refresh failed. Empty and failure states read "No agents running on any host." and "The fleet directory didn't answer: …". `AgentDirectory` takes an optional `silentHosts`.
