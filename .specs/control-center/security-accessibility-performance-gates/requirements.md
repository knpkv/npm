# Requirements

## Security

1. Existing hostile web-origin, host, LAN, hostile-content, and secret-handling suites remain mandatory release checks.
2. A browser-backed journey must prove the documented trusted HTTPS reverse-proxy deployment:
   - the browser uses an HTTPS public origin;
   - the application receives forwarded host, protocol, and client identity only from a configured trusted proxy;
   - pairing and authenticated navigation work from the simulated second machine;
   - the application still emits its production security headers.
3. Test credentials, pairing material, provider secrets, and session tokens must remain absent from rendered content, URLs, browser storage, benchmark reports, and normal logs.

## Accessibility and presentation

1. Every production route family must be represented in an explicit browser route inventory.
2. Each route family must have browser-backed evidence for:
   - keyboard reachability and visible focus;
   - no serious or critical automated WCAG violations;
   - usable 320 CSS-pixel reflow without root horizontal overflow;
   - forced-colors rendering without hidden primary content or actions;
   - reduced-motion rendering with no required interaction depending on animation.
3. Authenticated and unauthenticated presentations must both be covered where the route has both states.
4. Route inventory drift must fail a focused automated test.

## Performance and bounded resources

1. The existing deterministic fixture remains exact: 100 releases, 2,000 entities, 10,000 relationships/evidence records, 500 files, 20,000 timeline events, and a bounded 500-event SSE replay.
2. The real packaged runtime benchmark must continue to prove exact persisted cardinalities, ordered replay, one browser context, one managed server, and complete cleanup.
3. On the documented supported benchmark class, warmed authenticated portfolio availability must meet the two-second budget. The durable report must say whether the machine was eligible and whether the timing budget passed.
4. Ineligible machines must still run every correctness and lifecycle assertion; they may report timing as informational and must not masquerade as an acceptance result.
5. The report decoder must reject missing, contradictory, pruned, or over-budget eligible-machine evidence.

## Build/profile validation

1. Local browser workflows must rely on the Control Center build's manifest-based workspace artifact repair rather than unconditionally rebuilding unchanged dependencies.
2. The declared build-phase order and distribution-integrity phase must remain explicit and covered by a focused test.
3. CI must run the documented large-fixture contract benchmark and the browser-backed runtime benchmark as release gates without duplicating an avoidable dependency build.
4. Documentation must identify the exact commands, fixture, machine eligibility rule, budgets, output artifact, and failure semantics.

## Compatibility

1. No public API, storage schema, migration sequence, provider authority, or workspace authorization behavior changes.
2. The implementation remains compatible with the repository's Node 24 baseline and Chromium browser gate.
