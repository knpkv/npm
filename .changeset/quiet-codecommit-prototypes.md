---
"@knpkv/codecommit": patch
"@knpkv/ai-codex": patch
"@knpkv/jira-clockify": patch
---

Move both terminal applications from an OpenTUI preview build to the stable 0.5.1 release. Replace CodeCommit's flat pull-request detail page with an exact-head review workspace: complete changed-file inventory, lazy native diff previews, human decision state, preflighted prompt-only local Codex review actions, and deterministic detached worktree checkout. Add a prompt-only Codex transport mode for reviewing supplied untrusted text without host-capable tools or inherited instructions. Clear inherited repository-local Git variables before Relay and worktree commands so Git-hook callers cannot redirect them into the caller's repository.
