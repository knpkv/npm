# @knpkv/ai-codex

## 0.2.0

### Minor Changes

- [#345](https://github.com/knpkv/npm/pull/345) [`471974f`](https://github.com/knpkv/npm/commit/471974f89a86d01594cb9ac08d784ec1f4770541) Thanks [@konopkov](https://github.com/konopkov)! - Move both terminal applications from an OpenTUI preview build to the stable 0.5.1 release. Replace CodeCommit's flat pull-request detail page with an exact-head review workspace: complete changed-file inventory, lazy native diff previews, human decision state, preflighted prompt-only local Codex review actions, and deterministic detached worktree checkout. Add a prompt-only Codex transport mode for reviewing supplied untrusted text without host-capable tools or inherited instructions. Clear inherited repository-local Git variables, suppress configured hooks, and disable interactive authentication before Relay and worktree Git commands.

### Patch Changes

- [#350](https://github.com/knpkv/npm/pull/350) [`b4e09d6`](https://github.com/knpkv/npm/commit/b4e09d659a56b8213767ffda06dffb75fa74d489) Thanks [@konopkov](https://github.com/konopkov)! - Fix real-account CodeCommit TUI authentication actions, terminal text input,
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
  Route each finding to the PR description, PR comments, file-anchored PR comments,
  or exact line comments; add a wraparound finding deck, unresolved jump, publication
  target picker, and finding-specific follow-up conversations that reconcile the
  complete finding set and reopen affected local decisions. Verify an individual
  finding against CodeCommit's latest exact revision, report whether it was
  resolved, remains actionable, was superseded, or could not be established, and
  reconcile every dependent finding and human decision from the refreshed patch.
  Keep cached open pull requests when an account refresh fails, and publish newly
  fetched and enriched pull requests to the live TUI state before that same
  refresh completes. Preload a bounded prefix of immutable local file previews
  before exposing an exact-head workspace, then load larger-review overflow from
  the same local checkout, and make the second Ctrl+C consume the armed exit confirmation
  synchronously.
  Reject malformed or duplicate-id Relay output, isolate prior agent review text as
  untrusted prompt evidence, validate exact changed-side line anchors before
  posting, and keep edited or stale-posted findings attached to explicit human
  resolution and content-bound provider receipts. Preserve finding-post and
  conversation state across same-batch terminal input, and promote a successful
  manual exact-head checkout into local preview and editor readiness.
  Keep active provider-post receipts owned across workspace refreshes, base
  comment idempotency on the resolved repository account rather than a local AWS
  profile alias, and apply publication-target navigation synchronously.

## 0.1.0

### Minor Changes

- [#126](https://github.com/knpkv/npm/pull/126) [`c770262`](https://github.com/knpkv/npm/commit/c7702624d7e388f6e9e3cd0dc93845e195737406) Thanks [@konopkov](https://github.com/konopkov)! - Add Effect AI-compatible language model providers for authenticated local Claude Code and Codex CLI installations. The Codex adapter also exposes a bounded, cancellation-safe stream of validated native JSONL events for progress and tool-call observability.
