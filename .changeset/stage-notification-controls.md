---
"@knpkv/herdr-connect": minor
"@knpkv/herdr-hub": minor
---

Add stage notification controls for per-agent mutes and quiet hours in the user's time zone. Keep the last saved settings after failed changes and link devices with notifications off to Approvals. Let applications supply stage controls through the optional `ConnectSurface.stageFooter` prop.

Replace full-snapshot `PUT /v1/push/blocked-settings` with atomic `PATCH` intents for one agent's mute or quiet hours, so a stale device cannot overwrite another device's preferences. Queue mute toggles and quiet-hour reversions against their latest intended values. Save valid drafts on backdrop and Close dismissal while keeping Escape as cancel. Preserve keyboard focus while editing times, and show devices with stale subscription keys as off until Approvals reconciles them.
