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
`write:jira-work` is required to manage a version's "Related work" links and upload issue attachments.

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
jira auth login --site https://example.atlassian.net
```

Each successful login is saved as an auth profile keyed by the Atlassian account and site. Use profiles when you work across multiple Jira sites or accounts:

```bash
jira auth status
jira auth profiles
jira auth use <profile>
jira auth remove <profile>
```

`<profile>` may be a profile ID, profile name, site URL, cloud ID, or account ID.

## Usage

### Search by JQL

```bash
jira issue search 'project = PROJ AND status = Done'
```

### Search by Fix Version

```bash
jira issue search --by-version "1.0.0"
jira issue search --by-version "1.0.0" --project PROJ
```

### Options

| Option          | Alias | Description                              | Default          |
| --------------- | ----- | ---------------------------------------- | ---------------- |
| `--by-version`  | `-v`  | Search by fix version                    | -                |
| `--project`     | `-p`  | Filter by project key                    | -                |
| `--output-dir`  | `-o`  | Output directory                         | `./jira-tickets` |
| `--format`      | `-f`  | `multi` (one file per issue) or `single` | `multi`          |
| `--max-results` | `-m`  | Max results to fetch                     | `100`            |

### Issue Attachments

Upload a local file to an issue:

```bash
jira issue attachment upload PROJ-123 ./evidence.svg --no-insert
```

To place the uploaded attachment into an existing Markdown issue document, add a Markdown image or link placeholder for the local file, then pass the document path:

```markdown
![Evidence](./evidence.svg)
```

```bash
jira issue attachment upload PROJ-123 ./evidence.svg --document ./PROJ-123.md
```

The command uploads the file, replaces exactly one matching placeholder with the remote attachment reference, and includes hidden `jiraAttachment` metadata so later parses keep the Jira attachment identity.

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
jira version get 10042
jira version get 10042 --json
```

The version id is the **numeric** id (e.g. `10042`); use `version list` to find it.

### Set the description

```bash
jira version update 10042 --description "Q3 release"
```

Requires the `manage:jira-project` scope.

### Related work

Manage the "Related work" links (e.g. Confluence pages surfaced on a release report).

```bash
jira version related-work list 10042
jira version related-work add 10042 \
  --title "Release notes" \
  --url "https://example.atlassian.net/wiki/spaces/PROJ/pages/123" \
  --category Communication

# Reconcile the category to exactly this set — idempotent, safe to re-run
jira version related-work sync 10042 \
  --link "Release notes=https://example.atlassian.net/wiki/spaces/PROJ/pages/123" \
  --link "Test report=https://example.atlassian.net/wiki/spaces/PROJ/pages/124" \
  --category Communication \
  --prune
```

`related-work add` requires the `write:jira-work` scope.

`related-work sync` is what a release scaffold should use: repeated `add` calls pile up duplicate links, while
`sync` matches on URL (the only stable identity a link has, since Jira assigns the id and the title is editable)
and adds only what is missing. `--prune` additionally removes links in the category that are not in the desired
set, including surplus copies of a URL that _is_ desired. Other categories are never touched.

## Auth Commands

```bash
jira auth create     # Open Atlassian console to create OAuth app
jira auth configure  # Set client ID and secret
jira auth login      # Authenticate via OAuth
jira auth profiles   # List stored accounts/sites
jira auth use        # Switch active profile
jira auth remove     # Remove one stored profile
jira auth logout     # Remove stored credentials
jira auth status     # Show current auth status
```

## Programmatic Usage

```typescript
import { Effect, Layer } from "effect"
import * as Redacted from "effect/Redacted"
import { IssueService, IssueServiceLayer } from "@knpkv/jira-cli"
import { JiraApiClient, JiraApiConfig } from "@knpkv/jira-api-client"

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
  const issue = yield* client.getIssue("PROJ-123", undefined)
  console.log(issue.fields?.summary)
}).pipe(Effect.provide(JiraApiClient.layer), Effect.provide(configLayer))
```

## License

MIT
