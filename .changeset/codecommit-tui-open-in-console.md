---
"@knpkv/codecommit": minor
"@knpkv/codecommit-core": minor
"@knpkv/codecommit-web": patch
---

Add an "Open in CodeCommit" action to the TUI Changes tab, next to the Neovim
and VS Code shortcuts. Uppercase `C` opens the selected file in the AWS
CodeCommit console.

The link always names an exact commit, so the opened page cannot drift to a
newer head: a surviving file resolves to the reviewed source commit, and a
deleted file resolves to the destination commit, the only revision in the review
where the console can still render it. Unlike the editor shortcuts the action
reads the provider directly, so it needs no local checkout.

The link is copied to the clipboard when a clipboard tool exists and is then
handed to Granted's `assume`, which
is what turns the profile into a federated console session; the TUI yields the
terminal for the run so an expired SSO prompt stays visible and answerable. A
missing `assume` executable is reported as its own case — a dialog naming the
install and showing the link — rather than as one more failed
attempt, because there is nothing to retry until it is installed and an
unauthenticated console link only reaches a sign-in page.

Ctrl-C during a terminal handover now ends the child instead of the session. A
suspended renderer leaves the tty in cooked mode with `ISIG` enabled, so the
keystroke raised `SIGINT` on this process, where `runMain` interrupted the main
fiber and exited — discarding findings, dispositions and conversations, which are
component state. The session's interrupt teardown is now bracketed across
suspend/resume and `assume` runs in the terminal's foreground process group, so the
signal reaches the child. `SIGTERM` is deliberately left unbracketed so another
shell can still end the process, and Neovim is unaffected because raw mode makes
Ctrl-C a keypress rather than a signal.

`ChildEnv.profileScopedEnv` now takes the environment the child will inherit and
tombstones the spellings actually present, not only the canonical names. Windows
environment names are case-insensitive, so an ambient `Aws_Access_Key_Id` used to
survive beside the `AWS_ACCESS_KEY_ID` tombstone and outrank the requested profile.
The spawn stays `extendEnv: true`, so `PATH` and every other inherited variable are
untouched. `ChildEnv.HostEnvironment` is the service that supplies the inherited
environment at a runtime call site.

All five profile-scoped spawns now supply it — both `assume` paths, the sandbox
clone, and the exact-head Git commands — with the layer bound at each executable
boundary (the CLI, the TUI program, and the web server), since that is the only place
permitted to read the host process.
