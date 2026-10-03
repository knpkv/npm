---
"@knpkv/jcf-web": minor
---

A week of Jira and Clockify time in a browser, with the gaps a Coding Agent's sessions evidence
offered for confirmation one row at a time. Rows are Issue Keys, columns are the seven days of one
ISO week, and each cell carries both what the two systems already hold and what is missing — a gap
only means something next to the time logged around it, which is why `jcf sync reconcile --agent`
grew a grid rather than a longer list.

The engine is unchanged and unshared: `@knpkv/jira-clockify`'s own services, config, and write path,
so a week read here and a reconcile in a terminal derive the same rows from the same evidence.

A person may overrule the amount and the Issue Key, and nothing else. An amount above the credited
evidence is refused with the ceiling named; time no session evidences is a manual entry that claims
no evidence at all. An Issue Key override is re-tallied against the bucket it moves to before
anything is written. Both overrides are named in the text that lands in both systems.

Unplaced hours name the directories behind them, and one click turns a directory into a Standing
Attribution — the repair that makes recurring ticket-less work an ordinary proposal from then on.

Loopback only, with `@knpkv/codecommit-web`'s owner-session rules: a printed one-time URL, a session
cookie, an origin check, and a CSRF token on every write.
