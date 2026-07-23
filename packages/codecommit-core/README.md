# @knpkv/codecommit-core

Shared core library for CodeCommit tooling. Built with Effect-TS.

## Modules

### Domain

Schema.Class models with branded IDs (`PullRequestId`, `AwsProfileName`, `AwsRegion`, `RepositoryName`). Runtime validation at boundaries, serialization for SSE/persistence.

### AwsClient

AWS CodeCommit API wrapper. Each method uses `withAwsContext` — a combinator that handles credential acquisition, region injection, throttle retry, and timeout in one place:

```typescript
export const getPullRequest = (params: GetPullRequestParams) =>
  withAwsContext("getPullRequest", params.account, callGetPullRequest(params))
```

Methods: `getPullRequests`, `getPullRequest`, `createPullRequest`, `updatePullRequestTitle`, `updatePullRequestDescription`, `getCommentsForPullRequest`, `listBranches`, `getCallerIdentity`.

### ReadClient

The supported `@knpkv/codecommit-core/ReadClient.js` entry exposes a production read boundary for integrations. `CodeCommitReadProviderLive` performs real `@distilled.cloud/aws` calls, while `CodeCommitReadClient.layer` Schema-decodes the unknown responses into immutable pull request revisions, bounded changed-file pages, and repository-discovery pages. Repository discovery returns names and an opaque continuation token only; account identity and credential material remain behind the read boundary.

```typescript
import { ReadClient } from "@knpkv/codecommit-core"
import { Effect, Stream } from "effect"

declare const account: ReadClient.CodeCommitReadAccount
declare const baseCommit: string
declare const headCommit: string

const program = Effect.gen(function* () {
  const client = yield* ReadClient.CodeCommitReadClient
  return yield* client
    .streamChangedFiles({
      account,
      repositoryName: "payments-api",
      beforeCommitSpecifier: baseCommit,
      afterCommitSpecifier: headCommit
    })
    .pipe(Stream.runCollect)
})
```

The models preserve the exact pull request revision, base/head commits, merge base, old/new paths, blob IDs, modes, provider cursor, and requested provider page limit. `getBlob` reads one immutable blob through the same injectable provider and Schema boundary, retains at most 1 MiB, and distinguishes the provider's file limit from the read client's exact observed byte limit. Streams and blob reads inherit Effect interruption, so cancellation stops an in-flight provider call. Provider authentication/API failures, missing objects, malformed responses, and blob size limits remain typed.

`classifyCodeCommitFile` derives conservative binary/generated facts from bounded bytes and stable path signals. Binary detection requires a NUL byte; generated detection recognizes an explicit `generated` path segment, `.generated.`, minified/source-map suffixes, and common lockfiles. It deliberately avoids broad directory guesses such as `dist` or `vendor`. General ReadClient commit-history and comment queries remain later I01 slices; the ReviewClient uses a bounded internal comment read only for reconciliation. Callers must not infer classification merely from a successful inventory read without content.

### ReviewClient

The supported `@knpkv/codecommit-core/ReviewClient.js` entry exposes immutable pull-request review actions for server integrations. Every action carries the exact repository, pull request revision, base commit, and head commit that a caller authorized. `preflight` rejects a changed or closed target before a write, `execute` returns a secret-free provider receipt, and `reconcile` inspects provider state without replaying an ambiguous mutation.

```typescript
import { ReviewClient } from "@knpkv/codecommit-core"
import { Effect } from "effect"

declare const action: ReviewClient.CodeCommitReviewAction

const program = Effect.gen(function* () {
  const client = yield* ReviewClient.CodeCommitReviewClient
  yield* client.preflight(action)
  return yield* client.execute(action)
})
```

`CodeCommitReviewClient.live` supplies the raw mutation provider and still requires a `CodeCommitReadClient`, `AwsClientConfig`, and `HttpClient` when layers are composed. CodeCommit natively supports approve, revoke approval, and fast-forward merge. It has no request-review or request-changes state mutation, so those actions are idempotent comments attached to the authorized base/head commits. Comment reconciliation searches by AWS client request token; approval reconciliation reads the signed-in identity’s state; merge reconciliation verifies the exact merged source commit.

### CacheService (SQLite)

Local SQLite cache via `@effect/sql-libsql`. Stores PRs, comments, notifications, and subscriptions for instant search and offline access.

**Repos** — Each uses `Effect.Service` with `dependencies: [DatabaseLive]`:

- `PullRequestRepo` — CRUD + full-text search via FTS5
- `CommentRepo` — PR comment snapshots for diff detection
- `NotificationRepo` — Unified notifications (system + PR change)
- `SubscriptionRepo` — Per-PR watch subscriptions
- `SyncMetadataRepo` — Last-sync timestamps per account/region

**EventsHub** — `PubSub`-based cache invalidation. Repos publish `RepoChange` events (`Data.TaggedEnum`); consumers (SSE, TUI atoms) subscribe via `Stream.fromPubSub`. `EventsHub.batch` accumulates events during multi-step operations (e.g., full refresh) and publishes once at the end.

**Database** — Auto-migrates on startup. Migrations in `CacheService/migrations/`.

### PRService

Orchestrates the refresh pipeline: resolve accounts → stream PRs from AWS → diff against cache → enrich comments → calculate health scores → update state.

Key patterns:

- `Effect.fn("span")(function*(...) { ... })` — automatic tracing spans
- `SubscriptionRef` — reactive state shared with UI (TUI atoms, SSE)
- `Stream.mergeAll` with bounded concurrency for multi-account fetching
- `Clock.currentTimeMillis` for testable timestamps

### ConfigService

Loads/saves `~/.codecommit/config.json`. Auto-detects AWS profiles. Publishes config changes to EventsHub.

Consumers that only need the shared AWS profile catalogue can use
`discoverAwsProfiles(homeDirectory)` from `@knpkv/codecommit-core/ConfigService.js`.
It reads the standard AWS config and credentials files, deduplicates profile
names, and returns safe profile/region metadata only; credential values are
never returned.

## Deep Imports

Client-side code must use deep imports to avoid pulling in server-only deps:

```typescript
import { PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { AppStatus } from "@knpkv/codecommit-core/Domain.js"
import { CodeCommitReadClient } from "@knpkv/codecommit-core/ReadClient.js"
import { CodeCommitReviewClient } from "@knpkv/codecommit-core/ReviewClient.js"
```

The `.js` suffix is required — see package.json exports field.

## License

MIT
