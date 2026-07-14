# Milestone 7 — Hardening and delivery

Goal: prove recovery, security, accessibility, bounds, documentation, and repository-wide release readiness without using the final milestone to introduce missing architecture.

## H01 — Drain and reconcile every durable subsystem

- **Scope:** extend D09's lifecycle contract to every real adapter, agent job, provider stream, child process, and sandbox; atomically enter draining, reject new work, finish short committed work, cancel/interrupt scoped work, flush audit/events/WAL, release/expire leases, close handles, and reconcile all durable subsystems at startup.
- **Tests:** subprocess fault injection at every drain step, hard-deadline behavior, started/unknown action reconciliation, lease reclaim, no indefinitely running status.
- **Depends on:** D03, A03, A08, all adapters.
- **Review focus:** shutdown cannot widen authority, lose committed audit, or label ambiguous work successful.

## H02 — Add backup, restore, integrity, quarantine, and retention operations

- **Scope:** extend T12's verified backup/restore manifest through the final schema and blob classes; add WAL/integrity operations, per-class bounded retention/cleanup, and audit of cleanup/policy changes.
- **Tests:** previous-schema backup/restore, corrupt JSON quarantine, missing cache blob recovery, missing durable blob failure, interrupted backup, retention boundary/attribution.
- **Depends on:** T03, D01, D08, A03–A12.
- **Review focus:** no false-success backup, no cleanup of authoritative evidence, owner-only file permissions.

## H03 — Adversarially verify and tighten web, LAN, content, and secret boundaries

- **Scope:** audit every route/provider against the T04 SecretStore and T06 request/content/media foundations; tighten final body/decompression/time/rate bounds, CSP/security headers, URL/media allowlists, proxy types, sanitizer cases, redaction, secure/insecure LAN capability matrix, and second-machine operating test. No earlier route may wait for this commit to become safe.
- **Tests:** Host/Origin/CSRF/framing/MIME/traversal/slow-body/compression attacks; hostile Jira/Confluence/Markdown/SVG/diff/agent content; secret canaries across HTML/API/SSE/DB/log/audit/export/prompt/sandbox; explicit LAN reachability.
- **Depends on:** all server/routes/adapters.
- **Review focus:** loopback default, printed URL is usable, unsafe rich content cannot execute, browser never receives credentials.

## H04 — Complete accessible responsive themes and motion

- **Scope:** reconcile every primary route with dark/light/forced colors, 320 px and 200% zoom, reduced motion, keyboard flow, live announcements, semantic relationship/diff equivalents, collaborator naming, and manual screen-reader checklist.
- **Tests:** axe serious/critical zero, route keyboard E2E, zoom/reflow, theme/forced-color/reduced-motion screenshots, focus order/restore, screen-reader checklist record.
- **Depends on:** all production UI.
- **Review focus:** fix shared rly components rather than page-local copies; only code/diff may scroll horizontally.

## H05 — Enforce performance and bounded-resource budgets

- **Scope:** run documented 100-release/2,000-entity/10,000-edge/500-file/20,000-event/500-burst fixture; instrument portfolio, preview, search, SSE, diff, jobs, queues, memory and shutdown; tune pagination/cache/backpressure without data loss.
- **Tests:** five warmed runs with median/p95 report on baseline; hard page/queue/memory/process bounds; slow-client and burst correctness; interaction feedback and durable-job acknowledgement budgets.
- **Depends on:** all production paths.
- **Review focus:** timing calibration cannot weaken correctness/completeness assertions; no silent truncation or browser fan-out.

## H06 — Complete the documentation website for all new packages

- **Scope:** complete indexed Astro/Starlight pages and navigation/package-index entries for Control Center, rly, cdx, and cld. Reconcile installation, packed exports, Effect AI/rly examples, provider safety/capabilities/errors, real cdx smoke, Control Center configuration, architecture, plugin/agent/governance/sandbox behavior, and troubleshooting with implemented code. Publish rly's static Storybook catalog and link it directly from the rly documentation page.
- **Tests:** docs `check`/production build, route/link/search-index checks, packed-export references, checked code/command snippets where practical, no credentials/dangerous bypass examples, package README cross-links.
- **Depends on:** H01–H05 and every acceptance journey.
- **Review focus:** every new package has a real website page, not only README; documentation does not claim unverified behavior or stale CLI flags.

## H07 — Retire prototype runtime and finalize operations guides

- **Scope:** after parity evidence, remove prototype routes/runtime imports and unused prototype-only pages/styles while preserving approved screenshots/fixtures as non-runtime references; finalize pairing/LAN/TLS, backups/restore, retention, recovery, migration/upgrade and manual screen-reader guides.
- **Tests:** prototype-boundary/import/dead-route checks, docs links/commands, migration smoke, visual comparison record.
- **Depends on:** H01–H06.
- **Review focus:** no production behavior removed with fixture cleanup; preserved visual fixtures remain non-runtime.

## H08 — Run complete release gates and publish the reviewed draft PR

- **Scope:** finalize the initial changesets for all four new packages and every changed published owner package, lockfile/dependency audit, requirement traceability, a commit-by-commit finding-to-prevention review record, and draft PR description. Push/opening the draft PR occurs only at this item; package publication/deployment/merge remain unauthorized.
- **Tests:** frozen install; format; ESLint TS/TSX; Effect AST rules; all builds/checks/Vitest projects; rly generated/export/pack/registry/Storybook/visual gates; cdx/cld pack and fake-executable suites; deliberate real local cdx smoke with recorded version; Control Center integration/E2E/security/containment/benchmark gates; changeset/docs/link/dependency audits; committed finding-to-prevention records with reject/allow fixtures for every stable guardrail; clean process/container check.
- **Depends on:** H01–H07.
- **Review focus:** exact diff versus approved requirements/design/plan, no unrelated changes, every commit independently explained, every accepted finding linked to its shipped prevention guardrail or justified none rationale, no advisory silently suppressed.

After the draft PR opens, monitor CI and review threads. Diagnose failures from primary logs, make new narrowly scoped reviewed commits, rerun affected and full terminal gates, and continue until every required check passes and every actionable review thread is resolved. Do not merge or publish without separate user authorization.

## Exit gate

SC7.1–SC7.25 have linked evidence, the full repository gate is green, no stray browser/server/agent/sandbox process remains, the draft PR accurately describes the reviewed atomic series, and CI/review monitoring has reached a stable all-green state.
