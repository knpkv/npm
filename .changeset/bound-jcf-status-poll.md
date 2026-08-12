---
"@knpkv/jira-clockify": patch
---

Stop the nvim statusline poll from leaking `jcf timer status` processes, and
bound the command's Clockify calls.

The poll spawned `jcf timer status` with `detach = true` on every tick and never
waited for it. `status` does network I/O with no timeout, so a stalled request
kept its process alive indefinitely — and because the process was detached,
neither `VimLeave` nor `jobstop` could reap it. One nvim runs per project, so
every stalled poll was multiplied by the number of open editors.

Now at most one poll is in flight at a time, owned by nvim rather than detached,
under a watchdog; the spawn is skipped entirely when no timer is running
locally, since there is nothing to reconcile. On the CLI side the four Clockify
calls in the command are each bounded, so a stalled one degrades to printing
local state instead of pinning the process open.

The other thing that can stall a `status` run is the Jira auth config, built
before any command body runs, where an expired OAuth token triggers a network
refresh — and that matters for `status` invoked outside nvim too, which no
watchdog protects. The bound for it lives in `@knpkv/jira-cli`'s
`refreshTokenImpl` rather than here: the rotation is uninterruptible, so a
timeout on this call would be inert, and this layer is also the TUI's memoized
runtime, where degrading to an empty credential would 401 every Jira call for
the rest of the session. The nvim watchdog now sends SIGTERM with a grace period
longer than that refresh deadline before escalating, so a rotation in flight can
finish rather than being killed halfway.

Bounding the lookup made a hung request indistinguishable from the API
answering "no timer running" — both produce `null` — so the bound is applied
under the reachability check that gates clearing the state file, not around it.
`timer status` is what deletes local timer state unprompted, and the new test
suite pins that a lookup which times out — or answers after the deadline —
leaves the state file alone. The pipe ordering itself is only observable on an
exact tie between answer and deadline, which has no deterministic winner to
assert on, so it is held by a comment rather than a fixture.

Also fixes a state-cache bug this surfaced: the Lua reader invalidated on
whole-second mtime, so a timer started in the same filesystem second as the
previous read stayed invisible. Harmless when the poll ran unconditionally, but
the poll is now gated on that reading — a stale "inactive" would have suppressed
the refresh that fixes it. The cache key now includes sub-second mtime and size.

The Lua half ships with the package but was previously untested. It now has
specs that stub job control and time and run under `nvim --headless`, wired into
the vitest gate. They cover the single-flight invariant — including that a job
which ignores SIGTERM keeps holding the guard rather than letting a second poll
start — and the same-second cache write. The check workflow installs neovim so
they actually run; the suite skips only for local dev without the binary, and
fails rather than skipping when `CI` is set.
