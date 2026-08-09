---
"@knpkv/ai-codex": patch
"@knpkv/codecommit": minor
"@knpkv/codecommit-core": patch
---

Fix real-account CodeCommit TUI authentication actions, terminal text input,
quick-filter commands, settings key ownership, branch pagination, and Granted
console destinations, and support the Codex CLI 0.147 feature inventory for
prompt-only Relay runs. Align the TUI shell, pull-request list, exact-revision
workspace, settings, and dialogs with the Control Center visual language. Add a
hierarchical changed-file rail and human disposition of structured Relay
findings, including revision-preflighted CodeCommit comment posting. Prepare an
exact-head checkout when opening a PR, render diffs from immutable local Git
objects, and cache successful previews across file navigation. Preserve complete
bounded file-tree names at every hierarchy depth and make long rows horizontally
inspectable. Render every fetched review thread with explicit general, file, or
line coordinates and identify coordinates from older revisions instead of
hiding their comments. Open the selected verified exact-head file in
same-terminal Neovim or external VS Code, preserving a selected finding's line
anchor when available. Render textual changes as a synchronized, line-numbered
base/head split diff by default. Add a multi-select review-skill picker and
snapshot the selected PR Review / PR Diff Review playbooks into each prompt-only
Relay run. Present and post findings as evidence-led P1–P4 issue cards with
separate Summary, Details, Recommendation, Verification, and Location fields.
Route each finding to the PR description, PR comments, file comments, or exact
line comments; add a wraparound finding deck, unresolved jump, publication
target picker, and finding-specific follow-up conversations that reconcile the
complete finding set and reopen affected local decisions. Verify an individual
finding against CodeCommit's latest exact revision, report whether it was
resolved, remains actionable, was superseded, or could not be established, and
reconcile every dependent finding and human decision from the refreshed patch.
Keep cached open pull requests when an account refresh fails, and publish newly
fetched and enriched pull requests to the live TUI state before that same
refresh completes. Preload every immutable local file preview before exposing an
exact-head workspace so navigation and verification never flash a second loading
state, and make the second Ctrl+C consume the armed exit confirmation
synchronously.
