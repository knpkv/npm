---
"@knpkv/herdr-work": minor
---

Add the `abandoned` Work state and `WorkService.reconcile`. `reconcile` records each goal whose pull request is observed merged or closed as `completed` (delivery `merged`) or `abandoned`, stamped with the pull request's own close time (one millisecond after the goal's latest checkpoint when an owner wrote later). It writes only when that latest checkpoint is still the one it planned from, never stamps a goal twice, and always leaves 256 checkpoints of history free. `isTerminalWorkState` names the finished states; every check that treated `completed` as finished now treats `abandoned` the same way. Snapshots' `now` window now says who wrote each non-owner activity (`activityProvenance`, `activityProvenanceGoals`, `activityProvenanceOmitted`), trimmed by whole goals to the response budget.
