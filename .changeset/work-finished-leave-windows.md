---
"@knpkv/herdr-work": minor
"@knpkv/herdr-approvals": patch
---

The Work board shows what needs triage. A finished goal leaves a window a day after it finished, counted in `finishedOmitted` ("N finished goals not shown"), and each goal carries its 8 most recent activities, with `activityOmitted` counting the rest ("8 most recent of N"). Stored history is unchanged. `fleetctl work snapshot` names finished goals left out on stderr, too.
