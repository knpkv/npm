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

- Jira API: `read:jira-work`, `read:jira-user`
- User Identity API: `read:me`

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
