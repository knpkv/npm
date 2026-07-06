---
"@knpkv/jira-clockify": minor
---

Add End Correction to `jcf timer stop` — for when you forget to stop a running timer.

- Stopping a running timer now always confirms the end first (`Started HH:MM · ends now HH:MM (…)`), defaulting to now on Enter.
- Declining the confirm prompts for the real end as `HH:MM` (today) or a full ISO timestamp; a bare `HH:MM` that lands in the future rolls back to yesterday (the overnight "forgot to stop" case).
- Add `jcf timer stop --at <HH:MM|ISO>` to set the corrected end non-interactively (skips the confirm).
- The corrected end is validated (`start < end <= now`) and re-prompted on failure — never clamped, so a bad value can't silently log the full forgotten duration. The Clockify entry and Jira worklog both use the corrected end.
- The TUI stop flow gains the same confirm/edit step before the comment popup.
