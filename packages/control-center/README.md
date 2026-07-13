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

## Public entries

- `@knpkv/control-center` — browser-safe API and domain contracts
- `@knpkv/control-center/api` — shared typed API contracts
- `@knpkv/control-center/domain` — Schema-backed vendor-neutral domain contracts, including canonical IDs, people and agent roles, source freshness, and deterministic release identity
- `@knpkv/control-center/server` — server composition

The browser application is intentionally private. It consumes `@knpkv/rly`, while the root, API, domain, and server boundaries are mechanically prevented from importing the design system. Server composition is available only from the explicit `/server` entry. Production code is also forbidden from importing the approved prototype at runtime.

Release Relay projections are domain data, not presentation state. Each release persists its `relay/v1` codename and three-symbol projection; readers validate that projection against the canonical release ID so a future relay algorithm can be introduced without silently changing existing release identity.

## Persistence boundary

The server entry owns one scoped libSQL client and an owner-only content-addressed object directory. Ordered migrations, workspace-scoped repositories, optimistic revisions, and malformed-record quarantine keep durable state outside the browser. Large content bytes never live in normal SQL rows. Raw SQL, filesystem handles, and resolved storage paths never cross the runtime service boundary; local database and blob-root paths remain explicit, validated server configuration inputs.

Secure blob reads and publication require the host to expose opened files and directories through descriptor aliases at `/proc/self/fd` or `/dev/fd`. Operations fail with a typed containment error when neither alias can be verified; the store never falls back to trusting a replaced blob or shard pathname. The data-directory owner and same-UID processes are inside the local trust boundary: descriptor pinning rejects pathname substitution, but it cannot prevent an owner-authorized process from moving, reading, replacing, or deleting the already-open `0700` storage directory.

## Local authentication

`Auth` uses ten-minute, single-use pairing codes to create browser sessions. The first code for a workspace is unique and creates its owner; further device codes, session listing, and targeted revocation require an active owner session. Sessions have a twelve-hour sliding idle limit, a thirty-day absolute limit, and a separate CSRF credential for mutations. SQLite contains only SHA-256 credential digests. Invalid, expired, replayed, revoked, and malformed stored credentials share the same public rejection shape.

Use `authLayer(persistenceConfig)` from `@knpkv/control-center/server` for standalone composition. `TerminalRecovery` is a separate, terminal-only service: it derives the exact canonical `0700` directory from the configured database, requires an exact confirmation phrase, and proves that the running process owns the descriptor-pinned directory before it can issue an owner recovery code. Each successful recovery creates a durable audit event. Recovery is deliberately absent from the HTTP-facing `Auth` service.

Provider credentials belong in `SecretStore`, never normal SQL rows. The store returns opaque references, resolves bytes only inside a scoped zeroizing lease, and uses owner-only atomic files. It has the same `/proc/self/fd` or `/dev/fd` portability requirement and same-UID trust boundary as blob storage.

## Network exposure

`decodeBindConfig({})` resolves to `http://127.0.0.1:4173`. Non-loopback binds require an explicit public origin, exact Host and Origin allowlists, and exactly one transport policy:

- direct TLS with opaque `SecretStore` references for both certificate and private key;
- TLS terminated by an exact allowlist of trusted proxy IPs; or
- explicitly insecure LAN HTTP.

Insecure LAN mode is for a trusted private network only. It permits release viewing, release actions, and release-agent work, but blocks provider configuration, policy changes, pairing/session administration, and secret inspection. TLS modes set the session cookie `Secure`; every mode uses an opaque `HttpOnly`, `SameSite=Strict` cookie. The authenticated mutation guard composes exact Origin, session CSRF digest, and capability checks so transport middleware cannot accept an unverified token. Forwarded headers are ignored unless the immediate peer is an exact trusted proxy.

Wildcard addresses are bind targets, not browser URLs. Use `effectiveReachableUrls` to print the configured public origin and validated private-network addresses without ever presenting `0.0.0.0` or `::` as a destination.
