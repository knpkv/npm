---
title: Public Scrub
input: full_diff
tools:
  - browse_code
  - git_tools
  - github_api_read_only
  - modify_pr
# An explicit include restores files ignore.md skips; the recorded data below is
# listed by name as well, since it is where private values leak.
include:
  - "**"
  - "**/*.json"
  - "**/package.json"
  - ".specs/**"
  - "scripts/fixtures/**"
  - "**/stories/fixtures/**"
  - "**/.design-sync/fixtures/**"
  - "**/test/fixtures/**"
  - "design-refs/*/*.json"
# Design exports are hash-pinned bytes, large enough to exhaust the run budget,
# so no scrub reads them, even in their own ref PRs: those PRs are scrubbed by
# the manual DOM diff against the previous export.
exclude:
  - "design-refs/*/revisions/**"
  - "design-refs/*/screens/**"
  - "repos/**"
  - "pnpm-lock.yaml"
  - "docs/debt.md"
  - "docs/debt.baseline.json"
  - "**/CHANGELOG.md"
ignoreTests: false
maxBudgetPerRun: 2
maxBudgetPerPR: 10
conclusion: failure
---

# Public scrub

This repository is public. Check that the pull request publishes nothing private. Review the changed lines of
every file in the diff, including tests, fixtures, changesets under `.changeset/`, docs and configuration, and
read the pull request's title and description with the GitHub API.

## What fails the check

- **Personal names.** The name of a real person, in prose, comments, test data, fixtures or examples. Tests,
  stories and mock scenarios use synthetic role-based identities ("reviewer", "owner", "teammate"). Invented
  character names in design refs and their fixtures are allowed. Git authorship and `Co-authored-by` trailers in
  commits are not part of this check.
- **Agent names.** The name of an agent, pane or session from the author's tooling, used to say who did the work
  or who to ask.
- **`workers/` paths.** Any path into a `workers/` directory.
- **Machine-local paths.** A home directory (`/home/<user>/`, `/Users/<user>/`, `C:\Users\<user>\`), a `~/`
  path outside a documented, generic example, or a path into a private checkout or cache.
- **Hostnames and network names.** A machine's hostname, a tailnet name (`*.ts.net`), a Tailscale address
  (`100.64.0.0/10`), a private LAN address (`10.x`, `172.16–31.x`, `192.168.x`) or a `.local` / `.internal` /
  `.lan` host.
- **Internal URLs.** A link to a private dashboard, an internal tool, a private repository, a private chat or
  design project, or a signed URL. Public documentation, public repositories, public issues and pull requests in
  this repository, and loopback addresses (`localhost`, `127.0.0.1`, `[::1]`) used by tests and dev servers are
  fine.

Flag only text the pull request adds or changes. When you cannot tell whether a name belongs to a real person,
say so in the comment rather than staying silent.

## Reporting

Post each finding as one inline comment on the line that contains it, naming the category and the replacement
(a role, a generic path, a placeholder host). For a finding in the title or description, post one conversation
comment quoting the text. Any finding fails the check.

When there are no findings, make the entire final response exactly `All clear` on one line with nothing else.
