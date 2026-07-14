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

`restore <archive>` treats `CONTROL_CENTER_DATA_ROOT` as its destination. The configured destination must not exist, including as a dangling symlink, and it must not contain or be contained by the archive. Restore verifies the archive before creating the destination, publishes the restored data root without overwriting an existing or concurrently created target, and does not run database migrations. A later normal `control-center` start prepares the restored root and applies any required migrations.

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

`CONTROL_CENTER_ALLOW_INSECURE_LAN=true` is a deliberately restricted viewing mode, not remote onboarding. It blocks pairing, session administration, provider configuration, policy changes, and secret inspection. A new browser therefore cannot establish its required `HttpOnly` session in that mode; use trusted HTTPS for normal remote access.

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

## Persistence boundary

The server entry owns one scoped libSQL client and an owner-only content-addressed object directory. Ordered migrations, workspace-scoped repositories, optimistic revisions, and malformed-record quarantine keep durable state outside the browser. Large content bytes never live in normal SQL rows. Raw SQL, filesystem handles, and resolved storage paths never cross the runtime service boundary; local database and blob-root paths remain explicit, validated server configuration inputs.

A newly created configured data-root pathname is an atomic, relative symlink claim to a private sibling `.control-center-incoming-*` directory. The claim is deliberately retained: replacing it with a directory would reopen the no-clobber race that the claim closes. A move-preserving marker binds both the configured claim basename and the private target basename; startup validates that binding, ownership, and descriptor-pinned identity before using canonical operational paths internally. Existing real-directory data roots remain supported unchanged, except that `.control-center-incoming-*` is reserved for private publication targets and is rejected as a configured data-root basename.

Treat the configured symlink and its sibling target as one data-root unit for its whole lifecycle. Stop Control Center and every process that can write the data root before moving, copying, backing up, restoring, or deleting it. Use the [offline backup and restore commands](#offline-backup-and-restore) for portable backups; copying live SQLite files is not a safe backup procedure. While all writers remain stopped, operate on the containing parent tree rather than only the configured pathname; the relative claim remains valid after a parent-tree move. Do not dereference the symlink into a standalone copy or delete and recreate it while retaining its target. If the claim is lost and a marked sibling contains durable state, startup fails closed instead of silently creating a fresh database. Recovery is an explicit operator action: inspect the private sibling and verify the recovered unit before restarting. For a bound v2 marker, restore the configured pathname as a relative symlink to the marker's exact target basename. Marker-only siblings from an interrupted first publication carry no application state and do not block a fresh claim.

Version-one markers do not identify their configured claim. A direct real-directory v1 root can upgrade automatically, but no symlink-backed v1 root can: even a protocol-only target could be selected concurrently through another alias. For offline recovery, stop every writer, take and verify a backup, inspect the sibling target, remove the configured symlink, and move the complete sibling target into the configured pathname as a real directory before restarting. Never select a v1 sibling through a newly created alias. Because a staged v1 root cannot be attributed safely, every existing v1 root beneath a parent must be upgraded as a direct root or recovered offline before creating another data root beneath that parent.

Secure blob reads and publication require the host to expose opened files and directories through descriptor aliases at `/proc/self/fd` or `/dev/fd`. Operations fail with a typed containment error when neither alias can be verified; the store never falls back to trusting a replaced blob or shard pathname. The data-directory owner and same-UID processes are inside the local trust boundary: descriptor pinning rejects pathname substitution, but it cannot prevent an owner-authorized process from moving, reading, replacing, or deleting the already-open `0700` storage directory.

## Local authentication

`Auth` uses ten-minute, single-use pairing codes to create browser sessions. The first code for a workspace is unique and creates its owner; further device codes, session listing, and targeted revocation require an active owner session. Sessions have a twelve-hour sliding idle limit, a thirty-day absolute limit, and a separate CSRF credential for mutations. SQLite contains only SHA-256 credential digests. Invalid, expired, replayed, revoked, and malformed stored credentials share the same public rejection shape.

Use `authLayer(persistenceConfig)` from `@knpkv/control-center/server` for standalone composition. `TerminalRecovery` is a separate, terminal-only service: it derives the exact canonical `0700` directory from the configured database, requires an exact confirmation phrase, and proves that the running process owns the descriptor-pinned directory before it can issue an owner recovery code. Each successful recovery creates a durable audit event. Recovery is deliberately absent from the HTTP-facing `Auth` service.

Provider credentials belong in `SecretStore`, never normal SQL rows. The store returns opaque references, resolves bytes only inside a scoped zeroizing lease, and uses owner-only atomic files. It has the same `/proc/self/fd` or `/dev/fd` portability requirement and same-UID trust boundary as blob storage.

## HTTP API

The shared `@knpkv/control-center/api` entry exports the versioned `HttpApi` contract, generated client constructor, and URL builder. It covers browser pairing and session management, plugin metadata/health/configuration, the persisted portfolio snapshot, and authenticated media reads. The browser uses this generated client rather than handwritten paths or response types.

Plugin configuration updates are full replacements guarded by the current optimistic revision. Secret values never enter the configuration document: callers submit scoped opaque secret references, and reads return redacted reference state only. Media URLs contain an opaque `media_` identifier derived from the persisted content digest; the server does not fetch arbitrary URLs or expose storage paths.

The request boundary applies exact Host and Origin policy, session/CSRF/capability checks, correlation and security headers, bounded URL/header/body sizes, timeouts, and rate limits before API work. Static assets are captured into an immutable allowlisted map at startup and never resolved from request-controlled filesystem paths.

## Network exposure

`decodeBindConfig({})` resolves to `http://127.0.0.1:4173`. Non-loopback binds require an explicit public origin, exact Host and Origin allowlists, and exactly one transport policy:

- direct TLS with opaque `SecretStore` references for both certificate and private key;
- TLS terminated by an exact allowlist of trusted proxy IPs; or
- explicitly insecure LAN HTTP.

Insecure LAN mode is for a trusted private network only. It permits release viewing, release actions, and release-agent work, but blocks provider configuration, policy changes, pairing/session administration, and secret inspection. TLS modes set the session cookie `Secure`; every mode uses an opaque `HttpOnly`, `SameSite=Strict` cookie. The authenticated mutation guard composes exact Origin, session CSRF digest, and capability checks so transport middleware cannot accept an unverified token. Forwarded headers are ignored unless the immediate peer is an exact trusted proxy.

Wildcard addresses are bind targets, not browser URLs. Use `effectiveReachableUrls` to print the configured public origin and validated private-network addresses without ever presenting `0.0.0.0` or `::` as a destination.
