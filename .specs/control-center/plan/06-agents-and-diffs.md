# Milestone 6 — Complete diffs and first-class agents

Goal: prove diff completeness and stable anchors before executing review work, then add durable release-scoped agents and a hardened immutable-head sandbox.

## A01 — Serve complete PR inventory and lazy before/after content

- **Scope:** add the server-side diff read model/content service and client-safe presenter DTO/input schemas, content-addressed cache, authenticated bounded inventory/content/range endpoints, stable item/anchor IDs, path normalization, unavailable/oversized states, and new-head invalidation. It performs no React/rly mapping or URL-state work.
- **Tests:** 500-file pagination exhaustion, every status/path/blob ID, lazy content, cache corruption/refetch, binary/generated/large/provider limits, traversal/symlink hostile paths, anchor stability/staleness.
- **Depends on:** I03, S03, R15.
- **Review focus:** inventory is complete before “ready”; content is bounded/lazy; no credential-bearing direct media URL.

## A02 — Connect the full rly diff workbench

- **Scope:** implement the app-owned `CodeCommitDiffPresenter`, PR Files route/URL state, and mapping into rly's controlled diff props/callbacks; connect file tree, split/stacked, wrap, syntax/line/inline highlighting, context expansion, selection, annotations/findings, loading progress, virtualization, at-most-two renderer workers, and synchronous accessible fallback. rly remains renderer-only and performs no vendor/API access.
- **Tests:** actual pinned Diffs contract/browser tests for every fixture file, scroll-to, mode persistence, context expansion, selection, findings, worker failure/cleanup, light/dark/forced-color/mobile diff exception.
- **Depends on:** A01.
- **Review focus:** server and UI completeness match; no deep renderer import outside rly; worker lifetime is bounded.

## A03 — Add durable leased job supervision

- **Scope:** persist job/attempt/lease/event/output state; transactional claims, concurrency caps, cancellation, retry schedule, expired-lease reclaim, scoped fibers, output bounds, and progress-before-SSE ordering.
- **Tests:** claim race, TestClock expiry/retry, cancel at each stage, output backpressure, restart reclaim, duplicate ownership prevention, finalizer cleanup.
- **Depends on:** T03, T08.
- **Review focus:** client lifetime cannot own durable job lifetime; interrupted work is never reported successful.

## A04 — Persist isolated release threads and context snapshots

- **Scope:** enforce unique `(workspace, release)` thread, explicit context selection for entities linked to multiple releases, ordered human/agent/system messages, exact evidence/revision snapshots, redaction, and thread APIs.
- **Tests:** two releases/two sessions, foreign IDs, zero/one/multiple release selection, ordering, restart, prompt/secret redaction, deleted/stale evidence.
- **Depends on:** D01, A03.
- **Review focus:** no cross-release/workspace evidence; one durable thread is not duplicated per page.

## A05 — Add the deterministic fake agent and governed tool proposals

- **Scope:** define provider-neutral streaming event/result/tool contract, Schema decode, scripted fake provider, read-only evidence tools, blocker/description/check/review results, cancellation/usage, and proposal-only governed action handoff.
- **Tests:** delta/progress/tool/finding/result/error/malformed/interruption scripts, exact context, cancellation, usage absence/presence, agent cannot call executor/authorize.
- **Depends on:** D03, A03–A04.
- **Review focus:** provider output is untrusted; agent authority stops at a typed proposal.

## A06 — Publish cdx as an Effect AI Codex CLI provider

- **Scope:** add `packages/cdx` / `@knpkv/cdx` at `0.0.0` with initial minor changeset, strict exports/pack fixture, typed config/discovery/capabilities/errors, and an inner service built with `LanguageModel.make`. Wrap it in a raw-public-request guard that preserves the complete `LanguageModel.Service` interface and rejects unsupported caller options before Effect AI can normalize, consume, or execute them; retain an inner normalized-provider-options guard as defense in depth. Translate bounded stdin plus non-interactive `codex exec` JSONL/JSON-Schema output into Effect AI generate/structured/stream parts through `effect/unstable/process`; use ephemeral sessions, no color, reviewed least-permissive sandbox/config flags, minimal environment, validated cwd, scoped cancel/kill, and never pass approval/sandbox or hook-trust bypass flags. Add the indexed `packages/docs` cdx page with exports, Effect AI examples, safe profiles/capabilities/errors, cancellation, and real smoke workflow.
- **Tests:** fake executable covers missing/unsupported versions, every frame/chunk boundary, supported single-user/text plus text/unnamed-JSON response formats, auth/process failure redaction, timeout/output caps, cancellation/kill, pack/import and zero child leaks. A table-driven outer-guard matrix rejects system/multiple/history/assistant/tool messages; file/image/reasoning/tool/approval parts; explicit `objectName`; non-empty provider options; an empty toolkit; an effectful toolkit; explicit `toolChoice: "auto"` without a toolkit and every other non-`none` choice; supplied `concurrency`; supplied `disableToolCallResolution`; and approval history plus an effectful toolkit with typed `AiError`, zero CLI calls, and zero toolkit/handler effects. A public-service integration test seeds `ResponseIdTracker` and submits continuation-shaped history, proving the outer guard rejects it before delegation with zero effects. Inner-hook tests repeat the normalized tools/tool-choice/response-format checks, and a direct inner-hook contract test supplies normalized `previousResponseId`/`incrementalPrompt` and proves a non-fallback typed `AiError` with zero CLI calls. A separate deliberate `test:smoke:local` runs the installed authenticated Codex through the packaged Effect AI layer in an ephemeral read-only temporary git repository, validates structured plus streaming output, records version, enforces bounds, and verifies no file/process leak; it is not automatic CI/pre-commit.
- **Depends on:** R01 repository discovery; Effect beta API re-verification immediately before implementation.
- **Review focus:** independent reusable package, no Control Center/rly import, no terminal-prose scraping, no unsafe flags or inherited extensions, honest unsupported capability.

## A07 — Publish cld as an Effect AI Claude CLI provider

- **Scope:** add `packages/cld` / `@knpkv/cld` at `0.0.0` with initial minor changeset, strict exports/pack fixture, typed config/discovery/capabilities/errors, and the same guarded-service architecture as cdx: a raw-public-request `LanguageModel.Service` wrapper around an inner `LanguageModel.make` service plus a defense-in-depth provider-hook guard. Translate bounded stdin plus Claude non-interactive print/stream-JSON/JSON-Schema output into Effect AI generate/structured/stream parts through scoped Effect processes; disable session persistence, TTY, browser, extensions, extra directories and permission bypass, using the least-permissive version-verified settings/tool/MCP surface. Add the indexed `packages/docs` cld page with exports, Effect AI examples, safe profiles/capabilities/errors, cancellation, and optional smoke behavior.
- **Tests:** fake executable covers missing/unsupported versions, every frame/chunk, supported single-user/text plus text/unnamed-JSON response formats, auth/process failure redaction, timeout/output caps, cancellation/kill, pack/import and zero child leaks. The same outer-guard matrix, seeded-`ResponseIdTracker` public-history integration test, inner-hook matrix, and direct normalized-continuation inner-hook contract test as cdx reject unsupported shapes at the correct boundary with typed `AiError`, zero executable calls, and zero toolkit/handler effects. Real Claude smoke is explicit and optional.
- **Depends on:** R01; may share only test-fixture conventions with A06, never a runtime dependency on cdx.
- **Review focus:** independent package and safe default even when local user configuration is powerful; less-isolated profile fails closed unless version-specific bounds are proven.

## A08 — Add the replaceable Effect AI OpenAI-compatible HTTP provider

- **Scope:** add the repository-aligned direct `@effect/ai-openai-compat` dependency behind the contract, SecretStore endpoint/model/key-reference config, streaming translation, structured result decoding, interruption, usage metadata, and safe diagnostics.
- **Tests:** fake HttpClient/provider protocol, malformed frames, interruption, model/config validation, secret canaries across errors/logs/database/API.
- **Depends on:** A05, T04/T06.
- **Review focus:** no real key/network in tests, beta API isolated behind one adapter, no provider type in domain/client.

## A09 — Register and administer Effect AI providers

- **Scope:** Control Center directly consumes `@knpkv/cdx`, `@knpkv/cld`, and the HTTP provider through server-only supported exports; persist provider/model/safe-profile selection and capability/version/health, resolve SecretStore references, route jobs by provider identity, and expose redacted settings/diagnostics. Fake provider remains the normal E2E default.
- **Tests:** selection/revision conflicts, unavailable/unsupported CLI health, per-provider job routing, cancellation, two-provider concurrency, no browser import, no secret/env/command leakage, restart persistence.
- **Depends on:** A03–A08, I12.
- **Review focus:** provider registry is replaceable and server-only; no silent fallback that changes cost/authority/capabilities.

## A10 — Put the contextual agent on every primary page

- **Scope:** connect rly agent patterns to portfolio/release/Active work/Items/Timeline/settings/entity contexts; show exact evidence/freshness/provider/capabilities before composer; stream persisted jobs; support cancel/reopen/reconnect.
- **Tests:** page context matrix, close UI while job runs, live reconnect, keyboard/focus, two-release isolation, provider health, human/agent semantics, mobile drawer.
- **Depends on:** S01–S07, A04–A09.
- **Review focus:** not a generic chatbot; no context/provider ambiguity; agent never obscures principal content/action.

## A11 — Run immutable review work in a hardened sandbox

- **Scope:** use `effect/unstable/process` argument arrays to create digest-pinned, non-root, read-only, networkless, capability-dropped, quota/time/log-bound sandboxes; resolve/verify exact PR SHA, strip remotes/credentials, validate one mount, persist phases, and clean/reconcile durably.
- **Tests:** runner injection/quoting/output/cancel/finalizer tests plus separately gated Docker containment for UID, image digest, network, mounts, caps, quotas, timeout/restart and cleanup.
- **Depends on:** A01, A03, I03.
- **Review focus:** no shell fragments, Docker socket, arbitrary env/mount, host credential, detached process, or unauthenticated LAN port.

## A12 — Complete durable PR agent review and human disposition

- **Scope:** checkout→analysis→findings job, bounded immutable evidence passed to the selected host-side Effect AI provider, Schema/path/line validation, stable diff annotations, persisted recommendation, governed action proposals, and separate human approve/request-changes decision bound to head.
- **Tests:** fake provider plus cdx fake-executable integration, close/reopen/restart, stale/moved head, hostile finding paths/output, file/line anchors, cleanup failure recovery, human disposition, recommendation never impersonates approval, secret scan.
- **Depends on:** A02, A05–A11.
- **Review focus:** model does not need sandbox network; local CLI gets only bounded evidence/validated cwd; findings remain attributable/stale-aware; human authority stays distinct.

## Exit gate

The 500-file PR exposes every changed file and renders supported content through the real pinned Diffs wrapper. Both local wrapper packages pass fake-executable Effect AI contract/pack tests, and cdx passes its deliberate real local Codex smoke. A fake-agent/cdx-fixture review checks out the trusted immutable head in a contained sandbox, survives UI closure/restart, returns validated anchored findings, allows a separate human decision, and deterministically cleans up.
