# @knpkv/jira-cli

CLI tool to fetch Jira tickets and export to markdown.

## Installation

```bash
pnpm add @knpkv/jira-cli
```

Or link globally for development:

```bash
cd packages/jira-cli && pnpm link --global
```

## Setup

### 1. Create OAuth App

```bash
jira auth create
```

Opens Atlassian Developer Console. Create a new OAuth 2.0 (3LO) app with:

**Permissions:**

- Jira API: `read:jira-work`, `write:jira-work`, `manage:jira-project`, `read:jira-user`
- User Identity API: `read:me`
- Plus `offline_access` (issued automatically) so the CLI stays logged in across runs.

`manage:jira-project` is required to edit a version's description.
`write:jira-work` is required to manage a version's "Related work" links.

> **Upgrading?** If you authenticated before the `version` command was added, the
> new scopes are not yet granted to your token. Re-run `jira auth login` to
> re-consent and pick up `manage:jira-project`.

**Callback URL:**

```
http://localhost:8585/callback
```

### 2. Configure Credentials

```bash
jira auth configure --client-id <ID> --client-secret <SECRET>
```

### 3. Login

```bash
jira auth login
```

## Usage

### Search by JQL

```bash
jira search 'project = PROJ AND status = Done'
```

### Search by Fix Version

```bash
jira search --by-version "1.0.0"
jira search --by-version "1.0.0" --project PROJ
```

### Options

| Option          | Alias | Description                              | Default          |
| --------------- | ----- | ---------------------------------------- | ---------------- |
| `--by-version`  | `-v`  | Search by fix version                    | -                |
| `--project`     | `-p`  | Filter by project key                    | -                |
| `--output-dir`  | `-o`  | Output directory                         | `./jira-tickets` |
| `--format`      | `-f`  | `multi` (one file per issue) or `single` | `multi`          |
| `--max-results` | `-m`  | Max results to fetch                     | `100`            |

### Output Formats

**Multi (default):** One markdown file per issue with YAML front-matter.

```
./jira-tickets/
├── PROJ-123.md
├── PROJ-124.md
└── PROJ-125.md
```

**Single:** All issues in one combined file.

```
./jira-tickets/
└── jira-export.md
```

## Versions

Inspect and edit Jira project versions (releases) with Driver, Contributors and
Approver fields resolved to display names.

### List versions

```bash
jira version list --project PROJ
jira version list --project PROJ --released
jira version list --project PROJ --unreleased --max 10
jira version list --project PROJ --json
```

| Option           | Alias | Description                                                     | Default |
| ---------------- | ----- | --------------------------------------------------------------- | ------- |
| `--project`      | `-p`  | Jira project key (e.g. `PROJ`)                                  | -       |
| `--released`     |       | Only released versions (mutually exclusive with `--unreleased`) | `false` |
| `--unreleased`   |       | Only unreleased versions (mutually exclusive with `--released`) | `false` |
| `--max`          | `-m`  | Maximum number of versions to fetch                             | all     |
| `--custom-field` |       | Custom field display name to include per ticket (repeatable)    | -       |
| `--json`         |       | Output as JSON                                                  | `false` |

### View a version

```bash
jira version view 10042
jira version view 10042 --json
```

The version id is the **numeric** id (e.g. `10042`); use `version list` to find it.

### Set the description

```bash
jira version set 10042 --description "Q3 release"
```

Requires the `manage:jira-project` scope.

### Related work

Manage the "Related work" links (e.g. Confluence pages surfaced on a release report).

```bash
jira version relatedwork list 10042
jira version relatedwork add 10042 \
  --title "Release notes" \
  --url "https://example.atlassian.net/wiki/spaces/PROJ/pages/123" \
  --category Communication
```

`relatedwork add` requires the `write:jira-work` scope.

## Auth Commands

```bash
jira auth create     # Open Atlassian console to create OAuth app
jira auth configure  # Set client ID and secret
jira auth login      # Authenticate via OAuth
jira auth logout     # Remove stored credentials
jira auth status     # Show current auth status
```

## Programmatic Usage

```typescript
import { Effect, Layer } from "effect"
import * as Redacted from "effect/Redacted"
import { IssueService, IssueServiceLayer } from "@knpkv/jira-cli"
import { JiraApiClient, JiraApiConfig, toEffect } from "@knpkv/jira-api-client"

const configLayer = Layer.succeed(JiraApiConfig, {
  baseUrl: "https://mysite.atlassian.net",
  auth: {
    type: "basic",
    email: "user@example.com",
    apiToken: Redacted.make("your-api-token")
  }
})

// Using IssueService (high-level)
const program = Effect.gen(function* () {
  const service = yield* IssueService
  const issues = yield* service.searchAll('fixVersion = "1.0.0"')
  console.log(`Found ${issues.length} issues`)
}).pipe(Effect.provide(IssueServiceLayer), Effect.provide(JiraApiClient.layer), Effect.provide(configLayer))

// Or using JiraApiClient directly (low-level)
const direct = Effect.gen(function* () {
  const client = yield* JiraApiClient
  const issue = yield* toEffect(
    client.v3.client.GET("/rest/api/3/issue/{issueIdOrKey}", {
      params: { path: { issueIdOrKey: "PROJ-123" } }
    })
  )
  console.log(issue.fields?.summary)
}).pipe(Effect.provide(JiraApiClient.layer), Effect.provide(configLayer))
```

## License

MIT
