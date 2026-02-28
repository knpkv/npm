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

## Deep Imports

Client-side code must use deep imports to avoid pulling in server-only deps:

```typescript
import { PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { AppStatus } from "@knpkv/codecommit-core/Domain.js"
```

The `.js` suffix is required — see package.json exports field.

## License

MIT
