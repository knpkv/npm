# `@knpkv/control-center`

Control Center is a local, human- and agent-oriented delivery application. It connects release work across CodeCommit, CodePipeline, Jira, Confluence, and Clockify without allowing vendor models or server capabilities to leak into the browser.

This package is under active development, and its public API remains subject to change before `1.0.0`.

## Development

Node.js 24 or newer and the repository-pinned pnpm version are required.

```sh
pnpm --filter @knpkv/control-center dev
pnpm --filter @knpkv/control-center check
pnpm --filter @knpkv/control-center test
pnpm --filter @knpkv/control-center test:e2e
```

Development binds to `127.0.0.1:5173` by default. A LAN bind must opt into the security policy described below; a wildcard host alone is rejected.

### Distribution JavaScript budgets

`validate:dist` checks every emitted client and server `.js` file independently using its raw byte length and deterministic level-9 gzip byte length. Source maps, the Vite manifest, and `build-graph.json` are build metadata and are not runtime JavaScript artifacts.

| Target | Largest measured artifact   |       Measured raw / gzip | Per-artifact raw / gzip budget |
| ------ | --------------------------- | ------------------------: | -----------------------------: |
| Client | generated API client chunk  |    221,593 / 66,543 bytes |         235,000 / 70,000 bytes |
| Server | shared `BindConfig-*` chunk | 1,583,001 / 273,567 bytes |      1,650,000 / 290,000 bytes |

These initial ceilings were measured from a production build on 2026-07-19 and leave roughly four to six percent headroom, enough for build variance while rejecting meaningful per-file growth. The server chunk was about 6.87 MB raw and 1.09 MB gzip before the server build externalized declared runtime dependencies. Vite had followed linked workspace packages into their transitive graphs, including `confluence-to-markdown`'s Atlaskit schema/transformer, AJV, Markdown, and ProseMirror dependencies, `control-center-sql`'s query parser, and the broad `codecommit-core` root barrel. The server now keeps dependencies as runtime imports and uses narrow CodeCommit subpaths.

The remaining 1.58 MB raw shared server chunk is bounded technical debt: it is primarily Control Center's own shared application, persistence, plugin, API, and schema-snapshot graph. `BindConfig` is only Vite's generated chunk name, not the size owner. Future work should split that internal graph at deliberate runtime boundaries; raising the budget requires recording a new measurement and cause here.

## Run the application

Build once, then start the authenticated application server:

```sh
pnpm --filter @knpkv/control-center build
pnpm --filter @knpkv/control-center start
```

The first run prints a single-use pairing code and listens at `http://127.0.0.1:4173`. Durable data, content, and owner-only secrets live under `.control-center` by default; set `CONTROL_CENTER_DATA_ROOT` to choose another owner-controlled directory.

### Local OpenTelemetry

Control Center can export Effect traces and structured logs to an OTLP/HTTP collector. Export is opt-in and disabled unless the corresponding OpenTelemetry exporters are enabled. Metrics are not exported in this initial slice.

For example, start [motel](https://github.com/kitlangton/motel), then run Control Center against its default local listener:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:27686 \
OTEL_EXPORTER_OTLP_PROTOCOL=http/json \
OTEL_LOGS_EXPORTER=otlp \
OTEL_TRACES_EXPORTER=otlp \
pnpm --filter @knpkv/control-center start
```

To use [Lensflare](https://lensflare.dev/), create or select a dataset in its local UI and substitute that dataset's slug below. Lensflare listens on port `43110` by default and uses dataset-specific ingest routes:

```sh
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:43110/ingest/otlp/v1/logs/<dataset-slug> \
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:43110/ingest/otlp/v1/traces/<dataset-slug> \
OTEL_EXPORTER_OTLP_PROTOCOL=http/json \
OTEL_LOGS_EXPORTER=otlp \
OTEL_TRACES_EXPORTER=otlp \
pnpm --filter @knpkv/control-center start
```

Lensflare's optional MCP endpoint for querying the captured telemetry is `http://127.0.0.1:43110/mcp`; it is separate from the ingest endpoints above.

When an exporter is enabled without an endpoint, Control Center uses the OpenTelemetry defaults: `http://localhost:4318`, `/v1/logs` and `/v1/traces`, with `http/protobuf`. Set `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` for JSON-only collectors, or use the standard signal-specific protocol variables when the two signals differ. `OTEL_SERVICE_NAME` may override the default `control-center` service name, while the standard signal-specific endpoint and header variables can target another compatible collector. Exporters flush their bounded batches when the scoped Control Center runtime shuts down; collector outages do not fail application work.

`SIGINT` and `SIGTERM` begin graceful drain before scoped runtime resources close. The server rejects new authenticated mutations and live-event streams with a retryable `503`, closes existing live-event streams, and gives already-admitted mutations or startup background jobs up to ten seconds to finish. After that work and existing streams clear, one stable snapshot of named subsystem hooks runs sequentially. The governed worker appends immutable shutdown expirations for its still-live recovery claims so another process can reclaim them immediately; then the local SQLite hook checkpoints and truncates the WAL. Hook defects are reported by secret-free hook identity, and the hard deadline still bounds the complete work-and-flush sequence. Mutation-only callers retain a separate barrier that does not wait for startup background jobs or flush hooks. Startup release synchronization and governed-action recovery share the full-work admission barrier.

Fake release synchronization records an immutable attempt before acquiring its provider and appends a completion only after the synchronized page boundary is durable. Startup first reconciles every still-open attempt for the configured fake-provider stream as `interrupted`, using the stream's current durable revision and exact committed-page delta, then admits the next attempt. A provider outage completes as `source-unavailable`; cancellation, defects, and persistence failures never become successful synchronization records.

When the private governed worker is enabled, startup selects at most 64 actions from the configured bootstrap workspace whose recovery safety interval has elapsed. The `effect-qb` query uses stable lease/workspace/action order and excludes unexpired, un-released recovery claims. Each candidate enters the existing inspect-and-reconcile path sequentially, so startup never redispatches an ambiguous provider mutation. A candidate-list failure prevents the worker from becoming ready; individual typed failures and defects are counted in the secret-free startup summary while the remaining bounded batch continues. Runtime interruption still stops the sweep, and an explicitly expired claim rejects late provider outcomes while allowing immediate deterministic takeover.

### Local release agent

Every canonical release page has a release-owned Relay thread. An owner browser sends its bounded prompt and recent thread history through the typed API; the server resolves the current workspace-scoped release projection before each turn and runs the selected local CLI with read-only filesystem access. Provider configuration, credentials, filesystem paths, and raw provider failures remain server-only. Threads are isolated by browser session and currently remain in that tab; provider session identifiers are not treated as durable product state.

Local providers are disabled by default. Enabling one grants that CLI read access to the configured working directory, so use an owner-controlled, least-privilege checkout and trusted HTTPS:

```sh
CONTROL_CENTER_AGENT_PROVIDERS=codex,claude \
CONTROL_CENTER_AGENT_CWD=/srv/workspaces/payments \
pnpm --filter @knpkv/control-center start

# Keep local agents disabled while leaving the release UI available.
pnpm --filter @knpkv/control-center start
```

`CONTROL_CENTER_AGENT_CWD` is required whenever a provider is enabled; Control Center does not silently grant access to its launch directory.

`CONTROL_CENTER_AGENT_CODEX_EXECUTABLE`, `CONTROL_CENTER_AGENT_CODEX_MODEL`, `CONTROL_CENTER_AGENT_CLAUDE_EXECUTABLE`, and `CONTROL_CENTER_AGENT_CLAUDE_MODEL` provide server-only overrides. The respective CLI must already be installed and authenticated for the operating-system user running Control Center. Agent turns have a separate low-rate budget and a 130-second request deadline; each adapter applies a two-minute subprocess deadline and bounded output capture inside that request.

If the first code was lost after the workspace initialized, or no owner session remains, stop the server and run terminal recovery against the same data root:

```sh
pnpm --filter @knpkv/control-center start recover-owner
```

Recovery verifies the owner and mode of the canonical data directory, then requires the exact terminal phrase `ISSUE OWNER RECOVERY CODE`. A successful recovery revokes existing owner sessions and every outstanding pairing code before it prints a replacement single-use code. It is deliberately unavailable over HTTP.

### Offline backup and restore

Stop Control Center and every other process that can write its data root before creating or restoring a backup. The workspace commands below pass the same arguments as the installed `control-center` binary:

```sh
CONTROL_CENTER_DATA_ROOT=/srv/control-center \
pnpm --filter @knpkv/control-center start backup /srv/control-center-backups/2026-07-14

pnpm --filter @knpkv/control-center start verify-backup /srv/control-center-backups/2026-07-14

CONTROL_CENTER_DATA_ROOT=/srv/control-center-restored \
pnpm --filter @knpkv/control-center start restore /srv/control-center-backups/2026-07-14
```

`backup <archive>` treats `CONTROL_CENTER_DATA_ROOT` as its source. That source must already be a prepared Control Center data root, and its writers must remain stopped for the whole command. Backup does not create, adopt, repair, or migrate the source. The archive pathname must not already exist and must not contain or be contained by the source; publication fails rather than replacing caller-owned data.

`verify-backup <archive>` reads and verifies only the archive. It does not read `CONTROL_CENTER_DATA_ROOT`, even when that variable is set, and it does not modify the archive.

`restore <archive>` treats `CONTROL_CENTER_DATA_ROOT` as its destination. The configured destination must not exist, including as a dangling symlink, and it must not contain or be contained by the archive. Restore verifies the archive before creating the destination and publishes the restored data root without overwriting an existing or concurrently created target. A later normal `control-center` start requires the restored database to match the current unstable schema exactly.

Each successful offline command writes exactly one summary line to standard output and nothing to standard error: `Backup created.`, `Backup verified.`, or `Backup restored.` A valid archive with unavailable reproducible cache content remains usable and instead reports `Backup created with N reproducible cache gaps.`, `Backup verified with N reproducible cache gaps.`, or `Backup restored with N reproducible cache gaps.` Usage and command failures write only to standard error and exit nonzero; command failures use the stable `Control Center command failed (<ErrorTag>).` form without exposing storage paths or secret values.

The Vite development server stays loopback-only and is not the production application server. A new remote browser must pair over trusted HTTPS. The simplest supported setup keeps Control Center on loopback and puts a TLS reverse proxy on the same machine. Configure the proxy to serve a hostname and certificate trusted by the second machine, forward to `http://127.0.0.1:4173`, and overwrite `X-Forwarded-Host`, `X-Forwarded-Proto`, and `X-Forwarded-For`. `X-Forwarded-For` must contain exactly the browser's IP literal: do not append a chain or forward the incoming header. Then start Control Center with the proxy's exact address:

```nginx
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Proto https;
proxy_set_header X-Forwarded-For $remote_addr;
```

```sh
CONTROL_CENTER_HOST=127.0.0.1 \
CONTROL_CENTER_PORT=4173 \
CONTROL_CENTER_PUBLIC_ORIGIN=https://control.home.arpa \
CONTROL_CENTER_ALLOWED_HOSTS=control.home.arpa \
CONTROL_CENTER_ALLOWED_ORIGINS=https://control.home.arpa \
CONTROL_CENTER_TRUSTED_PROXY_ADDRESSES=127.0.0.1 \
pnpm --filter @knpkv/control-center start
```

Open `https://control.home.arpa` from the second machine and enter the one-time code printed by the server. Replace the example hostname with one that resolves to the server on both machines. If the local proxy connects over IPv6, trust its exact `::1` address instead of `127.0.0.1`. Never add client addresses or a subnet: forwarded headers are accepted only from the exact immediate proxy. Malformed, chained, or spoofed client-address headers fall back to the immediate peer for rate limiting.

Direct TLS is also available when certificate and private-key material has already been provisioned into this instance's `SecretStore`; pass the resulting opaque references as `CONTROL_CENTER_TLS_CERTIFICATE_REF` and `CONTROL_CENTER_TLS_PRIVATE_KEY_REF`. The application never accepts certificate paths or key bytes through environment variables.

`CONTROL_CENTER_ALLOW_INSECURE_LAN=true` is a deliberately restricted viewing mode, not remote onboarding. It blocks pairing, session administration, local agent execution, provider configuration, policy changes, and secret inspection. A new browser therefore cannot establish its required `HttpOnly` session in that mode; use trusted HTTPS for normal remote access.

## Public entries

- `@knpkv/control-center` — browser-safe API and domain contracts
- `@knpkv/control-center/api` — shared typed API contracts
- `@knpkv/control-center/domain` — Schema-backed vendor-neutral domain contracts, including canonical IDs, people and agent roles, source freshness, and deterministic release identity
- `@knpkv/control-center/server` — server composition

The browser application is intentionally private. It consumes `@knpkv/rly`, while the root, API, domain, and server boundaries are mechanically prevented from importing the design system. Server composition is available only from the explicit `/server` entry. Production code is also forbidden from importing the approved prototype at runtime.

Release Relay projections are domain data, not presentation state. Each release persists its `relay/v1` codename and three-symbol projection; readers validate that projection against the canonical release ID so a future relay algorithm can be introduced without silently changing existing release identity.

## Plugin contract

The version-one plugin contract is vendor-neutral and capability-negotiated. Descriptors use structured semantic versions and secret-free configuration metadata; each read, sync, diff, proposal, execution, cancellation, and reconciliation capability negotiates its own integer version. Unsupported contract majors, malformed descriptors, and unsupported required capabilities are rejected before an adapter factory runs.

Adapters emit bounded pages of Schema-decoded `UpsertEntity`, `TombstoneEntity`, `AppendEvidence`, `UpsertPerson`, and `ProposeRelationship` events. They cannot choose workspace or connection scope. Canonical descriptor JSON is capped at 60 KiB, normalized attributes, evidence, and governed-action payloads at 256 KiB, and each complete encoded sync page at 1 MiB; adapter transports enforce limits before buffering provider responses. Diff paths are normalized provider-relative paths, and decoded content ranges are valid base64 capped at 1 MiB and at the requested range. A decoded page and its next checkpoint commit in one transaction; replay uses stable event and page identities, malformed pages enter redacted quarantine, and failures never replace the last valid cache.

The exported `PluginConnection` service contains reads, health, sync, complete-diff access, and governed-action proposals only. Every proposal carries its canonical payload digest, and authorization must preserve that digest. Adapters implement a tag-free executor shape; plugin composition seals it behind a non-exported live service that only the governed-action engine may obtain. Source-boundary validation prevents adapters, browser code, and agent code from importing that authority. Safe reads and explicitly idempotent writes use at most three attempts with capped full jitter and decoded `Retry-After`; a stream is retried only before its first emitted page, and excessive `Retry-After` values fail instead of retaining a fiber. Unsafe or ambiguous mutations are reconciled rather than replayed.

### CodeCommit read adapter

The first production CodeCommit slice exports an opaque `CodeCommitPluginDefinition` from `@knpkv/control-center/server`. One connection configures an AWS profile, region, and repository name. It negotiates `entity.read@1`, `sync.incremental@1`, and `diff.inventory@1`, then normalizes open pull requests with immutable PR/base/head revisions and complete cursor-based changed-file pages. Provider output is decoded by `@knpkv/codecommit-core` before it enters the vendor-neutral plugin contract; raw AWS types and causes do not cross the adapter.

This milestone is deliberately read-only. It does not negotiate diff content, comments, commits/history, checks, review state changes, approval, merge, or any governed mutation capability. CodeCommit's changed-file API does not report binary, generated, or oversized classification, so this slice leaves those inventory flags false until the owning package gains bounded blob/content inspection.

### AWS CodePipeline read adapter

The server entry exports an opaque production CodePipeline plugin definition for one configured AWS profile, region, and pipeline. It negotiates `entity.read` and `sync.incremental` only. Direct `@distilled.cloud/aws` CodePipeline and STS calls remain behind an injectable provider service; repository-owned Schemas decode every returned account, pipeline, execution, and action shape before it can become plugin data. Credential, authorization, throttling, timeout, malformed-response, outage, and not-found outcomes remain typed and redacted.

Each execution provider page contains at most one execution, allowing its pipeline, execution, stage, and action events to fit one atomic plugin page and checkpoint. One synchronization invocation reads at most 20 execution pages. Action history requests at most 100 records per page, five pages, and 200 actions per execution; a truncated read is labeled instead of pretending to be complete. Discovery and execution snapshots use at most two concurrent provider calls. Provider cursors are opaque, replayable checkpoints, and repeated action cursors or mismatched identities fail closed.

Normalized events carry the pipeline ARN, region, provider update/sample time, immutable execution/action identities, status, operator provenance, source revisions, and bounded stage/action summaries. Artifact metadata contains only names and S3 bucket/key coordinates marked `proxy-required`; resolved action configuration, provider artifact URLs, revision URLs, and external execution URLs are never exposed. Start, stop, manual approval, retry, log-content, and artifact-content operations remain unnegotiated until their governed authorization, receipt, proxy, and reconciliation paths are implemented.

The canonical CodePipeline entity page is a read-first execution flight recorder. It correlates the already bounded pipeline, stage, and action events from one accepted provider page, preserves configured stage order, and shows execution identity, trigger and revision, derived deployment target, duration, operator and approval identities, action outcomes, and current release/PR/runbook evidence. The canonical projection deliberately removes S3 bucket/key coordinates and log ARNs: browser-visible artifacts retain only their name, direction, and `proxy-required` access state. Truncated stage or action reads remain explicitly labeled and are never presented as complete.

### Jira issue adapter

`makeJiraReadPluginRuntime` from `@knpkv/control-center/server` builds the production Jira adapter around the shared Schema-validated `JiraApiClient`. It negotiates bounded project synchronization, `entity.read` for `jira.issue`, and governed proposal, execution, and reconciliation capabilities for durable comments and available workflow transitions. Each action is pinned to the inspected issue revision; stale revisions or unavailable transitions fail before a provider mutation. Governed description replacement remains disabled because Jira Cloud does not expose an atomic revision precondition for issue edits.

The secret-free runtime configuration requires an HTTPS Jira Cloud tenant root `webBaseUrl` under `atlassian.net`, its stable Atlassian cloud `siteId`, the immutable `projectId` followed by this connection, an activity `pageSize` from 1 to 50, a `maximumPages` limit from 1 to 5, and a per-request `operationTimeoutMillis` from 1,000 to 120,000. Discovery verifies the project through Jira before it can become a followed resource, and entity reads fail closed when an issue belongs to another project. Authentication remains in the externally supplied `JiraApiClient` layer, so tokens never enter plugin configuration.

OAuth profiles provide the verified cloud ID used to share one Atlassian site across Jira and Confluence. Jira API-token connections remain usable but standalone because the scoped Jira REST surface does not prove that cloud ID; adding a Jira project from an existing site card therefore requires a matching OAuth profile. Confluence trusts the already-validated OAuth profile identity and verifies API-token setup through its system-information response. Pre-stability Jira descriptor generations without both `siteId` and `projectId` enter an explicit `plugin-configuration-migration-required` state; recreate those local connections while migrations are intentionally disabled.

An issue read fetches the issue, comments, and changelog through interruptible Effect operations. Pagination stops at the configured bound and records explicit comment/history truncation flags. The normalized issue attributes include description and environment text, workflow metadata, release versions, parent and subtasks, comments, history, and deduplicated collaborators with roles and avatar URLs. If fixed issue fields would cross the payload cap, optional arrays and presentation fields are omitted deterministically and named in `truncatedFields`. OpenAPI, HTTP, timeout, authentication, authorization, rate-limit, outage, and adapter-schema failures are translated to the closed plugin failure taxonomy without retaining raw provider causes.

Comment mutations carry a durable Control Center idempotency property. A timeout after dispatch becomes an unknown outcome and reconciliation searches newest-first bounded comment history for that property, then verifies the exact authorized payload digest before reporting success. Transition reconciliation similarly compares current provider state instead of replaying a mutation. Threaded-comment fallback and issue link/fix-version association remain follow-up Jira actions.

### Confluence space reader

The production Confluence adapter negotiates `entity.read@1` and bounded `sync.incremental@1` for the `pages` stream. Each connection is pinned to one immutable space ID under its verified Atlassian site. Space iteration always sends that exact ID to Confluence and rejects any returned page belonging to another space before attachment or person reads, so followed spaces sharing one OAuth site remain isolated.

Synchronization retains current page and bounded revision metadata, owner/author/contributor/watcher roles, and at most two pages each of watcher and attachment metadata without loading attachment bytes. Page bodies remain `contentState: "lazy"`; `entity.read` loads and safely converts ADF only when the page is opened. Titles containing operational runbook terms emit explicit `confluence.runbook-candidate` evidence rather than silently classifying a page as authoritative documentation.

One invocation reads at most five provider pages and persists a resumable `bounded:<cursor>` checkpoint when more work exists. Large provider pages are deterministically divided into contract-sized atomic pages. Intermediate chunks use a restart checkpoint for the current provider page so interruption replays stable event identities instead of skipping uncommitted entities.

This MVP remains read-only. Unbounded watcher/activity history, authoritative deletion evidence, scheduled or webhook synchronization, content search, and governed update/publish are deferred to later Confluence milestones.

### Clockify time-entry reader

`makeClockifyReadPluginRuntime` from `@knpkv/control-center/server` builds the first production Clockify adapter around the shared Schema-validated `ClockifyApiClient`. It negotiates only `entity.read` for `clockify.time-entry` and bounded `sync.incremental` snapshots on the `time-entries` stream. Credentials remain in the externally supplied client layer.

The secret-free configuration names the root Clockify web URL, immutable workspace ID, comma-separated user IDs, page size, maximum pages, maximum concurrency, and per-request timeout. At most ten users are accepted, and user count multiplied by page size may not exceed 100 normalized entries in one aggregated provider page. Sync reads one page per configured user with bounded concurrency, stops at the configured provider-page limit, and deterministically splits normalized output so every emitted `PluginSyncPageV1` remains within its 1 MiB UTF-8 envelope. A full final provider page uses a scope-bound `bounded:<page>:<digest>` checkpoint rather than claiming provider exhaustion.

Clockify's time-entry endpoint exposes offset pages but no stable snapshot cursor or window. Therefore resumable pages use an explicit `restart:<digest>` checkpoint: after an interrupted sync, the adapter restarts at provider page one and relies on stable event identities for idempotent replay instead of resuming at a mutable offset that could skip entries. Every checkpoint carries the SHA-256 digest of its workspace, ordered configured user set, and page bounds; changed sync scope and completed or bounded checkpoint replay also restart at page one.

Every provider response is decoded again at the adapter boundary before it becomes a normalized event. Time-entry facts preserve the configured workspace, provider user, project/task/tag IDs, billable and lock state, interval timestamps, provider duration, and explicit running/completed state. Provider interval timestamps supply source freshness; authentication, authorization, rate-limit, timeout, malformed-response, and outage failures remain in the closed plugin taxonomy.

This MVP is intentionally read-only. Workspace people, Jira-key association evidence, duration rollups, approval state, corrections, governed execution, cancellation, and ambiguous-outcome reconciliation remain deferred to I08/I09 rather than being represented as supported capabilities.

## Persistence boundary

The server entry owns one scoped libSQL client and an owner-only content-addressed object directory. The MVP schema is intentionally unstable: a fresh database is created from one checked-in schema snapshot, and an existing database must match it exactly. Schema changes are breaking and require recreating local development data. Versioned migrations start only after the persistence model is declared stable and a released database file must remain readable by a newer build.

Workspace-scoped repositories, optimistic revisions, and malformed-record quarantine keep durable state outside the browser. Large content bytes never live in normal SQL rows. Typed query plans live behind `@knpkv/control-center-sql`; raw SQL, query-builder types, filesystem handles, and resolved storage paths never cross the runtime service boundary. Local database and blob-root paths remain explicit, validated server configuration inputs.

The delivery graph is exposed to server workflows as one deep `read`/`write` module. Its atomic batches persist exact normalized entity revisions, explicit resolved or missing nodes, directional many-to-many relationships, and separately attributable evidence items and claims. Relationship and evidence revisions are append-only; confidence, provenance, lifecycle, release/environment scope, freshness, and retention remain domain data rather than UI inference. The SQL topology, digests, joins, and legacy pipeline-kind mapping stay private to the module.

A newly created configured data-root pathname is an atomic, relative symlink claim to a private sibling `.control-center-incoming-*` directory. The claim is deliberately retained: replacing it with a directory would reopen the no-clobber race that the claim closes. A move-preserving marker binds both the configured claim basename and the private target basename; startup validates that binding, ownership, and descriptor-pinned identity before using canonical operational paths internally. Existing real-directory data roots remain supported unchanged, except that `.control-center-incoming-*` is reserved for private publication targets and is rejected as a configured data-root basename.

Treat the configured symlink and its sibling target as one data-root unit for its whole lifecycle. Stop Control Center and every process that can write the data root before moving, copying, backing up, restoring, or deleting it. Use the [offline backup and restore commands](#offline-backup-and-restore) for portable backups; copying live SQLite files is not a safe backup procedure. While all writers remain stopped, operate on the containing parent tree rather than only the configured pathname; the relative claim remains valid after a parent-tree move. Do not dereference the symlink into a standalone copy or delete and recreate it while retaining its target. If the claim is lost and a marked sibling contains durable state, startup fails closed instead of silently creating a fresh database. Recovery is an explicit operator action: inspect the private sibling and verify the recovered unit before restarting. For a bound v2 marker, restore the configured pathname as a relative symlink to the marker's exact target basename. Marker-only siblings from an interrupted first publication carry no application state and do not block a fresh claim.

Version-one markers do not identify their configured claim. A direct real-directory v1 root can upgrade automatically, but no symlink-backed v1 root can: even a protocol-only target could be selected concurrently through another alias. For offline recovery, stop every writer, take and verify a backup, inspect the sibling target, remove the configured symlink, and move the complete sibling target into the configured pathname as a real directory before restarting. Never select a v1 sibling through a newly created alias. Because a staged v1 root cannot be attributed safely, every existing v1 root beneath a parent must be upgraded as a direct root or recovered offline before creating another data root beneath that parent.

Secure blob reads and publication require the host to expose opened files and directories through descriptor aliases at `/proc/self/fd` or `/dev/fd`. Operations fail with a typed containment error when neither alias can be verified; the store never falls back to trusting a replaced blob or shard pathname. The data-directory owner and same-UID processes are inside the local trust boundary: descriptor pinning rejects pathname substitution, but it cannot prevent an owner-authorized process from moving, reading, replacing, or deleting the already-open `0700` storage directory.

## Local authentication

`Auth` uses ten-minute, single-use pairing codes to create browser sessions. The first code for a workspace is unique and creates its owner; further device codes, session listing, and targeted revocation require an active owner session. Sessions have a twelve-hour sliding idle limit, a thirty-day absolute limit, and a separate CSRF credential for mutations. SQLite contains only SHA-256 credential digests. Invalid, expired, replayed, revoked, and malformed stored credentials share the same public rejection shape.

Use `authLayer(persistenceConfig)` from `@knpkv/control-center/server` for standalone composition. `TerminalRecovery` is a separate, terminal-only service: it derives the exact canonical `0700` directory from the configured database, requires an exact confirmation phrase, and proves that the running process owns the descriptor-pinned directory before it can issue an owner recovery code. Each successful recovery creates a durable audit event. Recovery is deliberately absent from the HTTP-facing `Auth` service.

Provider credentials belong in `SecretStore`, never normal SQL rows. The store returns opaque references and resolves bytes only inside a scoped zeroizing lease. New owner-only generations are opened exclusively, rebound to their canonical pathname by handle identity, written and synced through that stable handle, and returned only after the containing directory is synced. Failed generations are removed only while the same binding remains provable; ambiguous cleanup fails closed and may retain an unreturned opaque file. Rotation is copy-on-write: it returns a new reference while retaining the old generation until its consumers drain and remove it. Unlike blob storage, secret publication does not require `/proc/self/fd` or `/dev/fd`; it uses portable `dev`/`ino`/`uid` identity checks available on Linux and macOS. Same-UID processes remain inside the local trust boundary.

## HTTP API

The shared `@knpkv/control-center/api` entry exports the versioned `HttpApi` contract, generated client constructor, and URL builder. It covers browser pairing and session management, plugin metadata/health/configuration, the persisted portfolio snapshot, release-aware agent turns, and authenticated media reads. The browser uses this generated client rather than handwritten paths or response types. Agent turns are authenticated CSRF-protected mutations; the server derives workspace identity from the session and returns the exact bounded release projection and event cursor used for the answer.

An owner can run a live connection test from the Services page. The CSRF-protected endpoint acquires the workspace-scoped provider runtime, calls its health and discovery operations, and returns only a normalized provider identity, checked time, latency, and safe failure classification. Credentials, headers, provider response bodies, and executor authority never enter the response. The ordinary `start` command installs the first-party runtime map; embedded server compositions may still inject `pluginConnections` for tests or specialized hosting.

Fresh workspaces also see the fixed CodeCommit, CodePipeline, Jira, Confluence, and Clockify catalog. The safe provider identities are visible before pairing; choosing one carries that selection through pairing and opens its setup form immediately. `GET /api/v1/plugins` retains its original connection-summary array for existing v1 clients; after pairing, the Services page reads the additive `{ catalog, connections }` response from `GET /api/v1/plugins/overview`. A workspace owner can submit one bounded CSRF-protected setup request whose browser-generated connection ID, typed adapter settings, and transport-only credential strings are validated before writes. Secret strings are converted to opaque `SecretStore` references; the canonical SQL configuration contains references only. The application creates disabled metadata, inserts configuration with expected revision zero, accepts the catalog descriptor, enables with metadata CAS, invalidates the scoped connection map, and then runs the live identity test. Provider authentication or health failure is returned as the usable test result and does not roll back the enabled connection. Failure before configuration removes newly created secrets; later setup failure retains a visible disabled draft.

Configured connections can be enabled or disabled directly from Services through an owner-only, CSRF-protected transition. A changed connection invalidates only its scoped provider runtime; an idempotent transition performs no invalidation. Re-enabling immediately runs the same redacted live identity test. An empty Overview renders the complete branded first-party service launcher; choosing a service opens its setup form immediately.

Catalog field metadata marks adapter settings separately from credential fields. Jira and Confluence prefer one shared local Atlassian OAuth profile. An owner can start PKCE-protected Atlassian sign-in for the intended provider set from Services, return to the session-bound callback route, and explicitly choose one accessible site. Control Center requests only the intended providers' scope union and writes the selected token once to its canonical machine-local `control-center` profile store; both Jira and Confluence runtimes resolve that same credential record when its granted scopes support them. Before writing, it rechecks the canonical store's OAuth client configuration. A populated canonical store with a missing or different client configuration rejects completion without changing the store, while an empty canonical store receives the shared configuration and token. The first-run client secret crosses one bounded CSRF-protected request and is never returned, persisted in browser storage, or written to SQL; provider tokens never enter the browser or SQL. Existing `jira-cli` and `confluence-to-markdown` profiles remain discoverable as provider-specific legacy profiles rather than being merged into a shared credential, and an explicit API-token fallback retains the `email` and `apiToken` secret-store path. OAuth fills the stable Atlassian cloud ID automatically; API-token setup requires the same site ID explicitly.

Create one shared Atlassian OAuth app for Control Center on the server machine. Add `<public-origin>/services/oauth/atlassian/callback` as its callback URL and enable the complete scope union requested by the Jira and Confluence integrations: `read:jira-work`, `write:jira-work`, `read:jira-user`, `manage:jira-project`, `manage:jira-configuration`, `read:page:confluence`, `write:page:confluence`, `delete:page:confluence`, `read:attachment:confluence`, `write:attachment:confluence`, `read:me`, and `offline_access`.

Choose **Sign in with Atlassian** in Services. When no OAuth app has been configured, Control Center shows its exact callback URL and accepts the client ID and secret inline. The CSRF-protected server stores them directly in the machine-local `control-center` auth store before continuing sign-in; neither the Jira nor Confluence CLI needs to be installed or configured. Credentials can be corrected after a failed first exchange while the canonical store has no profiles. Once a profile is saved, the existing configuration is reused and cannot be silently replaced. Matching legacy CLI configurations remain a compatibility fallback only. Non-loopback callbacks use the trusted HTTPS proxy or direct-TLS setup described above; insecure LAN mode cannot configure providers. A grant expires after ten minutes, is bound to the initiating workspace and browser session, and is consumed once at code exchange and once at site selection. Token expiry remains anchored to the provider exchange response even when site selection or a safe completion retry occurs later.

Clockify similarly keeps `apiKey` in the secret store, and its API origin remains a fixed server-owned runtime constant. Local AWS and Atlassian profiles are machine-local credential selectors, never persisted cloud identity. After a successful live test, the server transactionally reuses the discovered AWS account or provider-verified Atlassian site, follows the discovered service resource, and binds the executable connection. One AWS account can therefore own many CodeCommit repositories and CodePipeline pipelines; one Atlassian site can own multiple Jira projects and independently followed Confluence spaces. Account-card Add actions keep that site pinned while the global catalog remains site-selectable. Bound Atlassian site, project, and space identity fields are immutable; adapter-only settings such as a Confluence health page can still be changed. The authenticated human remains redacted connection-test evidence rather than becoming the provider account identity. The Services form sends all selected resources through one bounded server request and receives ordered, redacted per-resource outcomes, so a retry skips resources that already succeeded. The batch is not yet atomic: one later resource may fail after earlier resources have committed. Services presents each identity as one verified account or site card with compact resource rows. The server discovers the shared AWS CLI profile catalogue from its standard AWS files and returns only profile names and configured regions; credentials never cross the API or enter the browser. Manual profile entry remains available when discovery is unavailable.

An owner can explicitly test one AWS profile and region before setup. Control Center verifies the STS account identity, then independently lists CodeCommit repositories and CodePipeline pipelines through their Schema-decoded read boundaries. Each service reads at most five provider pages, returns at most 20 deduplicated and sorted names, and reports safe service-specific authorization, rate-limit, timeout, malformed-response, or availability failures. Identity failure is terminal, while one resource service may remain usable when the other fails. Refresh preserves current selections, and manual repository or pipeline names remain available as a fallback. No credentials, raw provider causes, or resource ARNs cross the API.

Configured CodeCommit, CodePipeline, and Clockify resources expose their durable synchronization state in Services. The card distinguishes never attempted, running, synchronized, and source-unavailable outcomes and shows the last attempt, last success, and committed-page count. Owners can invoke the existing CSRF-protected synchronization endpoint with **Sync now** and refresh the result; other members retain read-only state. The ordinary `start` command installs the production runtime registry; specialized embedded compositions without a `PluginConnectionMap` retain a visible disabled draft and report service unavailable.

The authenticated Timeline merges bounded pages from governed-action audit events,
plugin sync commits, relationship revisions, and domain events. Each source query
is workspace-scoped, parameterized, newest-first, and capped before the server
performs one deterministic merge. The browser receives default-redacted actor
labels, provider provenance when available, safe internal links, and a stable
timestamp-plus-event-key cursor. Actor and UTC date filters execute at the source;
watchers cannot read the Timeline. CSV and JSON download endpoints reuse that
default-redacted projection and stable cursor, require an explicit event limit,
and cap every export at 1,000 events with explicit truncation metadata. Every
successful download records immutable human/session attribution, filters,
format, counts, truncation, and timestamp before streaming begins. Owners
can deliberately expand one exact event to inspect its durable identifiers and
agent-job reference in a focused browser sheet with a Timeline-aware Relay
entry; approvers retain the ordinary redacted page and receive no inspect
control. Persisted artifacts and retention mutations remain deferred.

Plugin configuration updates are full replacements guarded by the current optimistic revision. Secret values never enter the configuration document: callers submit scoped opaque secret references, and reads return redacted reference state only. Media URLs contain an opaque `media_` identifier derived from the persisted content digest; the server does not fetch arbitrary URLs or expose storage paths.

### Production first-party runtime

The server owns one scoped runtime cache shared by connection administration. A lookup first loads the exact workspace-scoped connection, configuration, and negotiated descriptor records. Disabled, absent, malformed, cross-provider, or stale-descriptor records fail before a provider client is acquired. Invalidation closes the cached layer and its secret leases; the runtime authority digest changes with connection and configuration revisions, runtime revision and descriptor generation, descriptor digest, and credential reference generation.

Provisioning must persist the descriptor-advertised keys with the exact value kinds below. AWS uses the local profile chain and stores no credential secret. The Clockify API origin is fixed by the server as `https://api.clockify.me/api` and is not configurable.

| Provider     | Required persisted keys                                                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CodeCommit   | `profile` (text), `region` (text), `repositoryName` (text)                                                                                                                    |
| CodePipeline | `profile`, `region`, `pipelineName` (text); `maximumExecutionPages`, `actionPageSize`, `maximumActionPages`, `maximumActionsPerExecution`, `operationTimeoutMillis` (integer) |
| Jira         | `webBaseUrl` (url), `siteId`, `projectId`, `email` (text), `apiToken` (secret reference), `pageSize`, `maximumPages`, `operationTimeoutMillis` (integer)                      |
| Confluence   | `siteBaseUrl` (url), `email` (text), `apiToken` (secret reference), `siteId`, `spaceId`, `probePageId` (text)                                                                 |
| Clockify     | `apiKey` (secret reference), `webBaseUrl` (url), `workspaceId`, `userIds` (text), `pageSize`, `maximumPages`, `maximumConcurrency`, `operationTimeoutMillis` (integer)        |

The runtime catalog remains read-oriented. It is not installed as the governed action executor registry; existing governed fake-registry coverage remains the only write-execution composition in this slice.

The request boundary applies exact Host and Origin policy, session/CSRF/capability checks, correlation and security headers, bounded URL/header/body sizes, timeouts, and rate limits before API work. Static assets are captured into an immutable allowlisted map at startup and never resolved from request-controlled filesystem paths.

## Network exposure

`decodeBindConfig({})` resolves to `http://127.0.0.1:4173`. Non-loopback binds require an explicit public origin, exact Host and Origin allowlists, and exactly one transport policy:

- direct TLS with opaque `SecretStore` references for both certificate and private key;
- TLS terminated by an exact allowlist of trusted proxy IPs; or
- explicitly insecure LAN HTTP.

Insecure LAN mode is for a trusted private network only. It permits release viewing and ordinary release actions, but blocks local agent execution, provider configuration, policy changes, pairing/session administration, and secret inspection. TLS modes set the session cookie `Secure`; every mode uses an opaque `HttpOnly`, `SameSite=Strict` cookie. The authenticated mutation guard composes exact Origin, session CSRF digest, and capability checks so transport middleware cannot accept an unverified token. Forwarded headers are ignored unless the immediate peer is an exact trusted proxy.

Wildcard addresses are bind targets, not browser URLs. Use `effectiveReachableUrls` to print the configured public origin and validated private-network addresses without ever presenting `0.0.0.0` or `::` as a destination.
