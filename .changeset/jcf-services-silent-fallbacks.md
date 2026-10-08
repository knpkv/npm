---
"@knpkv/jira-clockify": minor
"@knpkv/jcf-web": minor
---

jcf no longer reports success for writes that failed, and no longer falls back silently. `ConfigService.set` fails with `ConfigUnreadable` when `~/.jcf/config.json` cannot be read (instead of overwriting it with defaults) and with `ConfigNotSaved` when it cannot be written. `ClockifyAuth.save` fails with `ClockifyKeyNotSaved` when the key cannot be written or made owner-only. A Clockify project or tag that cannot be looked up while starting a timer, an unreadable state, cache or config file, and a Jira identity or search failure keep their fallback but log a warning naming what was dropped and why. Saving defaults during `timer start` or `timer stop` reports a failure without stopping the timer. In jcf-web, a settings save that fails now answers with the reason instead of a generic error.
