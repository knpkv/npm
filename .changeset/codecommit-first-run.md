---
"@knpkv/codecommit": patch
---

The CLI's first run says what to do next:

- `codecommit pr list` without AWS credentials names the profile and region, and suggests `aws sso login --profile …` or `--profile` with a listed profile, instead of logging a stack trace.
- `--filter` presets with no enabled accounts exit 1 and point to `codecommit web` (Settings, Accounts) or `codecommit tui`.
- `pr list --all` with nothing to show says "No pull requests found."
- Bare `codecommit` without an interactive terminal exits 1 with one line instead of drawing the terminal UI into a pipe.
- `tui`, `web` and the web flags have help descriptions, and the terminal UI's header names the product "CodeCommit".
- `pr list` without `--region` reads the profile's region from `~/.aws/config` instead of us-east-1, and says which profile and region it read; warnings logged while listing go to stderr, so stdout and `--json` stay clean.
