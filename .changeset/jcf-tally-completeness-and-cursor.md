---
"@knpkv/jira-clockify": patch
---

Stop `--agent` mode from writing hours that already exist, and stop `jcf watch` from losing hours it
half-wrote. Five defects, all in the same direction: something the recorded side actually held was
invisible to the subtraction, so the gap looked bigger than it was.

- **The Clockify tally read one page.** It asked for no page size, so it got Clockify's default of 50. On any busy week the entries past that read as time Clockify never had. Now paged until a page
  comes back empty — a short page is not the last one, since the server may serve fewer than asked —
  and a run that would exceed the page bound fails rather than acting on a partial tally.
- **An entry crossing midnight counted entirely against the day it started.** Session credits are
  split at each local midnight, so a 23:30–00:30 entry left the following day looking untouched.
  Recorded intervals are now split the same way.
- **The watch's resume cursor moved before the write.** It advanced past every settled block, then
  looked up tickets, generated descriptions and wrote. A Jira refusal after Clockify had succeeded
  therefore persisted a cursor past a row whose Jira half was missing, so the restart the command
  asks the user to perform skipped it. `--dry-run` had the same shape without the failure: it wrote
  nothing and still resolved everything. A block now stays behind the cursor until both sides that
  were short have taken it.
- **The Jira worklog search treated a page with no `issues` as an empty one.** The generated schema
  makes the field optional, so a truncated or changed response read as "this user logged no work".
  Both that and an issue with no readable key now fail closed.
- **`--day` and `--week` were an hour out on daylight-saving transitions.** The endpoint was a local
  midnight plus 24 elapsed hours, which on a 23- or 25-hour day is not the next midnight. Both ends
  are now anchored to a real local midnight.

Also: `jcf watch` refuses to start when the lease cannot be written at all, rather than treating an
unwritable config directory as evidence that another watch holds it and running unprotected; each
lease is signed, so a watch displaced by a look that outran its own expiry stands down at its next
look instead of writing alongside its replacement; an in-scope transcript that cannot be read fails
the run instead of being skipped, because omitting it hands its share of an overlapping interval to
whichever session happened to be readable; issue keys delimited by underscores — `feature_PROJ-42_work`
— are now recognised, where `\b` had matched nothing and left the session unattributed and so
unlogged; and entries created by `--agent` carry the configured billable default, which `jcf timer
start` already sent.

The daylight-saving tests for the calendar grid were passing on ordinary 24-hour days: the suite ran
in whatever zone the machine had, and the dates they pin are US transitions. It now runs in a fixed
zone, and both tests fail with the old arithmetic restored.
