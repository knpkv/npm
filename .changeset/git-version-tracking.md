---
"@knpkv/confluence-to-markdown": minor
---

Add git version tracking and CLI improvements

- Add GitService for git operations with version history replay
- Add clone command that pulls pages with full version history
- Flatten git commands: confluence commit/log/diff (was: confluence git ...)
- Add auth status subcommand
- Reorganize bin.ts into separate command files
- Add nice error messages without stack traces
- Clone fails if already cloned
