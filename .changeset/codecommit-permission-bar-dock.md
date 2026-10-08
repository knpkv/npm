---
"@knpkv/codecommit-web": patch
---

The read permission bar docks to the bottom edge instead of entering the page above it, so a prompt that arrives after the page has painted no longer pushes everything down (the Settings layout shift on a first run). The page keeps the bar's height free at its end. While the identity read waits for that permission, Settings → Accounts says "Waiting for read permission" instead of a sign-in state.
