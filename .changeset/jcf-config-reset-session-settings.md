---
"@knpkv/jira-clockify": patch
---

`jcf config reset` now also clears the session settings it displays. `jcf config show` lists the
Session Roots, Standing Attributions and Idle Cap, so leaving them untouched was invisible: a user
chasing a bad Idle Cap would reset, see it still there, and have nothing to go on.

A hand-edited `~/.jcf/config.json` is also held to the bounds the `jcf config set` subcommands
already enforce. An Idle Cap of `0` made every presence window zero-length, so nothing was ever
proposed again; a confidence floor above `1` — `70` for "70%" is the obvious slip — withheld every
Coding Agent attribution permanently. Both now fall back to the default instead.
