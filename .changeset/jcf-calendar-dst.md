---
"@knpkv/jira-clockify": patch
---

Draw `--calendar` by the local clock rather than by distance from midnight. The two differ on a
daylight-saving day: after a spring-forward, work at 03:00 sat two hours from midnight and was drawn
in the `02h` row, and after a fall-back every later block shifted by an hour so the last of them ran
off the end of the grid and vanished — precisely when the grid is being used to judge whether a
proposal is right.

Also states what the transcript pre-read filter can actually guarantee. Scope is decided from the
project directory's name, and that name is a lossy encoding of the working directory, so a root
`/a/b-c` and an out-of-root `/a/b/c` collide. A colliding transcript is opened and then discarded
unread; every other out-of-scope transcript — 155 of 157 on the author's machine — is never opened.
The module claimed the stronger thing.
