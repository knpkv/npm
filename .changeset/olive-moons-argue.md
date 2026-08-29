---
"@knpkv/jira-clockify": minor
---

Bound `jcf timer status` to roughly one run per machine per interval, however
many Neovim instances are open, instead of one run per editor.

Two files beside the configured `state_path` do it. A `poll.lock` lease, created
with `O_EXCL` so the kernel picks the winner, stops two editors reconciling at
once; a holder that dies or wedges past the lease deadline is reclaimed by the
next editor to look. A `poll.stamp` then bounds the rate: the lease is released
as soon as the CLI exits, so on its own it would still let de-phased editors
spawn on nearly every tick, and a tick that finds the stamp younger than one
interval skips instead — the reconciliation it would run has already happened,
and the result is read from the state file.

The first poll after `start_poll` is jittered by `pid % interval_ms` so editors
opened in a batch do not line up on the same millisecond.
