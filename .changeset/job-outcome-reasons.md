---
"@knpkv/herdr-fleet": minor
---

New `@knpkv/herdr-fleet/job-outcome` export. `jobOutcome(record)` says what became of a job: pending, running, succeeded, rejected, expired, failed, or failed after a person approved it. `jobFailureReason(error)` sorts a failure into a closed set of reasons with one plain line each ("The agent didn't report back in time", "The hub restarted while it ran", "The checkout wasn't on main", …). A structured agent error is matched by its code before any text.
