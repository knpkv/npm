# `@knpkv/control-center`

Control Center is a local, human- and agent-oriented delivery application. It connects release work across CodeCommit, CodePipeline, Jira, Confluence, and Clockify without allowing vendor models or server capabilities to leak into the browser.

This package is under active development. Its first public release will be `0.1.0`.

## Development

Node.js 24 or newer and the repository-pinned pnpm version are required.

```sh
pnpm --filter @knpkv/control-center dev
pnpm --filter @knpkv/control-center check
pnpm --filter @knpkv/control-center test
pnpm --filter @knpkv/control-center test:e2e
```

Development binds to `127.0.0.1:5173` by default. A LAN bind must opt into the security policy described below; a wildcard host alone is rejected.

## Run the application

Build once, then start the authenticated application server:

```sh
pnpm --filter @knpkv/control-center build
pnpm --filter @knpkv/control-center start
```

The first run prints a single-use pairing code and listens at `http://127.0.0.1:4173`. Durable data, content, and owner-only secrets live under `.control-center` by default; set `CONTROL_CENTER_DATA_ROOT` to choose another owner-controlled directory.

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

The server entry exports an opaque production CodePipeline plugin definition for one configured AWS profile, region, and pipeline. It negotiates `entity.read` and `sync.incremental` only. Direct `distilled-aws` CodePipeline and STS calls remain behind an injectable provider service; repository-owned Schemas decode every returned account, pipeline, execution, and action shape before it can become plugin data. Credential, authorization, throttling, timeout, malformed-response, outage, and not-found outcomes remain typed and redacted.

Each execution provider page contains at most one execution, allowing its pipeline, execution, stage, and action events to fit one atomic plugin page and checkpoint. One synchronization invocation reads at most 20 execution pages. Action history requests at most 100 records per page, five pages, and 200 actions per execution; a truncated read is labeled instead of pretending to be complete. Discovery and execution snapshots use at most two concurrent provider calls. Provider cursors are opaque, replayable checkpoints, and repeated action cursors or mismatched identities fail closed.

Normalized events carry the pipeline ARN, region, provider update/sample time, immutable execution/action identities, status, operator provenance, source revisions, and bounded stage/action summaries. Artifact metadata contains only names and S3 bucket/key coordinates marked `proxy-required`; resolved action configuration, provider artifact URLs, revision URLs, and external execution URLs are never exposed. Start, stop, manual approval, retry, log-content, and artifact-content operations remain unnegotiated until their governed authorization, receipt, proxy, and reconciliation paths are implemented.

### Jira issue reader

`makeJiraReadPluginRuntime` from `@knpkv/control-center/server` builds the first production Jira adapter around the shared Schema-validated `JiraApiClient`. Its negotiated surface is deliberately limited to `entity.read` for `jira.issue`; provider mutations and workspace-wide JQL synchronization are not implied by this adapter.

The secret-free runtime configuration requires an HTTPS Jira Cloud tenant root `webBaseUrl` under `atlassian.net`, an activity `pageSize` from 1 to 50, a `maximumPages` limit from 1 to 5, and a per-request `operationTimeoutMillis` from 1,000 to 120,000. Authentication remains in the externally supplied `JiraApiClient` layer, so tokens never enter plugin configuration.

An issue read fetches the issue, comments, and changelog through interruptible Effect operations. Pagination stops at the configured bound and records explicit comment/history truncation flags. The normalized issue attributes include description and environment text, workflow metadata, release versions, parent and subtasks, comments, history, and deduplicated collaborators with roles and avatar URLs. If fixed issue fields would cross the payload cap, optional arrays and presentation fields are omitted deterministically and named in `truncatedFields`. OpenAPI, HTTP, timeout, authentication, authorization, rate-limit, outage, and adapter-schema failures are translated to the closed plugin failure taxonomy without retaining raw provider causes.

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

Configured connections can be enabled or disabled directly from Services through an owner-only, CSRF-protected transition. A changed connection invalidates only its scoped provider runtime; an idempotent transition performs no invalidation. Re-enabling immediately runs the same redacted live identity test, while the Overview empty state links directly to first-service setup.

Catalog field metadata marks adapter settings separately from credential fields. Jira and Confluence descriptors explicitly include `email` and `apiToken`; Clockify explicitly includes `apiKey`. The production runtime registry removes those credential fields before decoding the adapter configuration schemas and resolves references only while acquiring the provider client. Clockify's API origin remains a fixed server-owned runtime constant and is neither submitted nor persisted. AWS connections use local profile and region configuration and accept no secret input. The ordinary `start` command installs the production runtime registry; specialized embedded compositions without a `PluginConnectionMap` retain a visible disabled draft and report service unavailable.

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
| Jira         | `webBaseUrl` (url), `email` (text), `apiToken` (secret reference), `pageSize`, `maximumPages`, `operationTimeoutMillis` (integer)                                             |
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
