# Milestone 2 — Authenticated tracer slice

Goal: prove one thin production path from an authenticated browser through typed APIs and durable state to one fake plugin and back through resumable live updates.

## T01 — Scaffold the Control Center package and boundaries

- **Scope:** add the `0.0.0` package metadata, client/server TypeScript projects, Vite/Vitest/Playwright configuration, explicit exports, Node 24 scripts, `@knpkv/rly` dependency, root references, and one initial minor changeset targeting the first `0.1.0` release.
- **Tests:** client cannot import server; server/domain cannot import rly; build output has separate browser/server graphs; Playwright reports one worker.
- **Depends on:** R16.
- **Review focus:** direct dependency hygiene, no copied CodeCommit Web dependency set, no prototype runtime import.

## T02 — Define canonical IDs, actors, freshness, and release identity

- **Scope:** add Schema-backed branded IDs, UTC timestamps, actor/person roles, source revisions, freshness states, release records, and domain-owned `relay/v1` projection.
- **Tests:** property/golden tests for canonicalization, stable codename/three distinct indices, algorithm versioning, decode rejection, and human/agent distinction.
- **Depends on:** T01.
- **Review focus:** no assertions/`any`, no presentation types in domain, persisted provider IDs remain explicit despite future short package names.

## T03 — Add ordered libSQL migrations and repositories

- **Scope:** create database service/layer, migration ledger, workspace/plugin/release/entity/people tables, content-addressed owner-only blob store boundary, transactions, revisions, quarantine, and fixture builders.
- **Tests:** fresh/previous-schema migration, transaction rollback, optimistic conflict, blob digest/path containment, malformed-record quarantine, scoped teardown.
- **Depends on:** T02.
- **Review focus:** no raw host APIs in Effect code, forward-only migrations, secret values structurally excluded.

## T04 — Add pairing, sessions, and safe bind configuration

- **Scope:** implement loopback-first configuration, printed effective URLs, one-time pairing, multiple device sessions, recovery/revocation, secure cookies, Host/Origin/CSRF middleware, and an owner-protected `SecretStore` with opaque credential references, minimal resolution scopes, file-mode checks, rotation/removal, and structurally redacted configuration schemas.
- **Tests:** loopback default, explicit LAN bind, pairing expiry/replay, two sessions, revoke/recover, Host/Origin/CSRF rejection, insecure-origin policy, SecretStore permission/rotation/reference isolation, no secret serialization/logging.
- **Depends on:** T03.
- **Review focus:** authenticated UI/API/SSE, clear HTTP-on-LAN limitations, no misleading host/port or bearer identifier in share URLs.

## T05 — Define the versioned plugin contract and fake adapter

- **Scope:** add descriptor/capability negotiation, configuration/health, paginated normalized reads, checkpoints/tombstones/evidence, typed failure taxonomy, scoped layer registry, and deterministic fake adapter. The versioned contract includes `proposeAction`, preflight, internal `executeAuthorizedAction`, cancellation, provider receipt, and ambiguous-outcome reconciliation; only the governed engine may call execution.
- **Tests:** shared contract suite covers pagination/replay, 401/403/429, timeout, malformed response, outage, cancellation, checkpoint atomicity, independent plugin failure, action capability negotiation, exact-once authorized fake execution, and reconciliation.
- **Depends on:** T02–T04.
- **Review focus:** vendor-neutral records, unknown-major quarantine, last-valid cache retention, bounded retries only for safe operations.

## T06 — Expose the first typed HTTP API and static application

- **Scope:** add Effect HttpApi groups for session, plugin health/configuration, and portfolio snapshot; typed client generation; application providers/router; correlation IDs and typed errors. Establish central request/decompression/time/rate limits, static containment/MIME/CSP, rich-content sanitizer, external URL policy, and authenticated size/MIME-checked media proxy before vendor content routes exist.
- **Tests:** Schema boundary, auth scope, every initial limit, slow/compressed bodies, static traversal/MIME/CSP, sanitizer/unsafe URL/media proxy attacks, typed error mapping, direct SPA path load, handler disposal.
- **Depends on:** T04–T05.
- **Review focus:** no server details in browser exports, no raw causes or credentials, one authoritative API contract.

## T07 — Normalize one fake release into the portfolio shell

- **Scope:** persist a fake plugin sync atomically and render the rly shell/Overview with one release, identity, verdict placeholder, stages, people, provenance, freshness, health, and loading/empty/stale/error states.
- **Tests:** server integration sync/reload and page tests for all data states; presenter tests prove domain-to-rly mapping; no prototype fixture import.
- **Depends on:** T03, T05–T06.
- **Review focus:** server-authoritative state, application presenter owns derivation, source failure does not erase cache.

## T08 — Add durable cursor-backed SSE

- **Scope:** persist versioned domain events/outbox, authenticated SSE resume/reset, client reconnect with capped jitter, dedupe/order handling, authoritative invalidation, slow-client bounds, and accessible connection state.
- **Tests:** disconnect/replay/reset/out-of-order/duplicate/slow-client tests; UI convergence equals snapshot; session isolation and deterministic stream closure.
- **Depends on:** T03–T07.
- **Review focus:** event stream is not a second source of truth; commit-before-broadcast; bounded queues.

## T09 — Add release preview and canonical full-route transition

- **Scope:** make all release activations open rly preview first; add explicit full route, origin/back/refresh state, focus/inert/scroll behavior, shared geometry with reduced-motion fallback, and contextual agent placeholder showing exact context.
- **Tests:** pointer/keyboard preview, focus restoration, Escape, only explicit full navigation, direct refresh, not-found, mobile/zoom/reduced-motion browser path.
- **Depends on:** T07–T08.
- **Review focus:** no default/demo entity substitution, stable URL, preview remains compact and understandable.

## T10 — Prove the paired tracer in bounded Chromium

- **Scope:** add the managed Playwright server/database fixture, Chromium-only `workers: 1`/`fullyParallel: false`, process accounting, and the complete pairing→configuration→Overview→preview→full→refresh/reconnect journey.
- **Tests:** run the browser journey twice; assert browser contexts, application process, streams, and temporary database are closed after success and failure.
- **Depends on:** T01–T09.
- **Review focus:** no inherited development server, real provider/network, shared mutable database, or leftover Chromium process.

## T11 — Establish large-fixture and benchmark harnesses early

- **Scope:** add deterministic generators for the final 100-release/2,000-entity/10,000-edge/500-file/20,000-event fixture, initial portfolio/SSE measurements, explicit page/queue caps, and machine/result metadata. Later milestones extend the same fixture rather than inventing a new benchmark.
- **Tests:** generation determinism, bounded initial ingestion/read/SSE, one browser context, report schema, no timing assertion before documented warmup.
- **Depends on:** T03, T07–T10.
- **Review focus:** performance architecture is tested before breadth; correctness and bounds are hard assertions while environment-sensitive timing is reported honestly.

## T12 — Establish verified backup and restore foundations

- **Scope:** add the migration write barrier, atomic libSQL backup plus blob manifest, integrity verification, restore into a fresh data directory, and durable-vs-reproducible blob classification before the schema grows. Later milestones extend this same manifest and compatibility suite.
- **Tests:** fresh and previous migration backup/restore, interrupted backup, invalid manifest, missing reproducible cache blob recovery, missing durable blob failure, owner-only file modes.
- **Depends on:** T03, T11.
- **Review focus:** backup success is reported only after database and blob manifest verification; no restore can overwrite a live data directory in place.

## Exit gate

From a clean data directory: start loopback server, pair a browser, configure the fake plugin, persist one release, render Overview, receive an SSE update, open preview, explicitly open full view, refresh, return to the same origin, then restart and recover the same state. Confirm the bounded browser and benchmark harnesses leave no process or handle behind, then back up and restore the tracer state into a separate directory.
