---
"@knpkv/hub-app": patch
---

The standalone shell keeps `/app/shell.css` for good only when it is asked for under its current hash; an older page's link gets `no-cache`. A shell stylesheet missing at start is read again on the next request instead of failing until restart.
