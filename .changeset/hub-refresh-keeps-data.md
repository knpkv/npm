---
"@knpkv/herdr-approvals": patch
---

A failed hub refresh no longer replaces the whole app with "Host activity unavailable" and an error stack. The hub keeps showing the last update it had (the page's own snapshot if the very first refresh fails), with an inline "Couldn't refresh host activity. Showing the update from 09:41." notice and a Try again button. The cause goes to the log.
