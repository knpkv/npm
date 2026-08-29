---
"@knpkv/jira-clockify": minor
---

Bound `jcf timer status` to roughly one run per machine per interval, however
many Neovim instances are open, instead of one run per editor.

Two files beside jcf's fixed `~/.jcf/state.json` do it. A util-linux `flock` on
`poll.lock` stops two editors reconciling at once. The lock is attached to the
`jcf` process itself, so a killed editor cannot release it while its poll is
still running. A `poll.stamp` then bounds the rate: `jcf` checks and writes it
while holding the lock, and a stamp younger than one interval means a managed
attempt already finished. Failed attempts are stamped too, so a persistent
failure cannot make every editor retry inside the same interval; readers keep
the last state file until the next attempt.

The first poll after `start_poll` is jittered by `pid % interval_ms` so editors
opened in a batch do not line up on the same millisecond.
