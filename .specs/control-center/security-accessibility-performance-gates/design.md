# Design

## Shape

This slice turns existing evidence into explicit release gates and adds only the two missing end-to-end surfaces: production-route presentation audits and the trusted HTTPS proxy journey.

```text
deterministic fixture
        |
        +--> contract benchmark --> exact caps/cardinalities
        |
        +--> packaged runtime --> portfolio + bounded SSE + lifecycle report
                                      |
                                      +--> eligible machine: enforce 2 s portfolio p95
                                      +--> other machine: preserve correctness, mark timing informational

route inventory --> mocked production routes --> keyboard / axe / 320 px /
                                              forced colors / reduced motion

HTTPS browser --> test TLS proxy --> trusted forwarded headers --> packaged runtime
```

## Route audit

A browser helper owns a typed inventory of canonical route presentations. Existing route-specific fixtures continue to supply domain state. The helper performs the same compact set of assertions for each entry:

- main content and a route-specific landmark are visible;
- Tab reaches the route-owned primary action and proves a painted focus indicator;
- axe-core reports no `serious` or `critical` WCAG 2.0/2.1/2.2 A/AA violations, including the explicitly enabled experimental label-content-name rule;
- a 320-pixel viewport has no document-level horizontal overflow;
- forced-colors and reduced-motion emulation preserve the landmark and primary action;
- the primary action is exercised under those media modes and its immediate outcome is asserted.

A focused unit test compares the typed route/presentation inventory with the router's declared path, index, wildcard, and layout-only patterns so a newly added route or session-dependent branch cannot silently escape the matrix. Each browser owner consumes its exact assigned cases. Dynamic path parameters are represented by canonical safe fixture identities, and a genuinely actionless read-only presentation requires an explicit reason.

## Trusted HTTPS journey

The real-runtime fixture gains an optional, owned HTTPS reverse proxy:

- the application binds to loopback HTTP;
- its public origin is the proxy's HTTPS origin;
- only loopback is configured as a trusted proxy;
- the proxy overwrites, rather than appends, forwarded host/protocol/client headers;
- the browser context accepts the fixture certificate and connects through the HTTPS origin;
- lifecycle cleanup is registered immediately after each server is created.

The journey pairs through the public origin, reaches an authenticated workspace route, and verifies the complete secure-only header branch and the absence of sensitive values from browser HTML, URL, and serialized storage keys and values. The certificate and key are generated inside the test-owned temporary directory and have no production trust.

## Runtime benchmark report

Report version 2 adds:

- a named two-second warmed portfolio p95 budget;
- deterministic eligibility facts (Linux x64/arm64, Node 24+, at least four
  logical CPUs, 8 GiB memory, and an explicit local-SSD declaration);
- `timingAcceptance` with `eligible`, `passed`, and a stable reason;
- a schema refinement that rejects eligible reports whose p95 exceeds the budget or whose acceptance flags contradict the measurement.

Machine eligibility does not bypass the benchmark. It controls only whether absolute timing is an acceptance assertion; all correctness, ordering, cardinality, resource-cap, and cleanup checks remain unconditional.

## Browser build reuse and CI

The Control Center build already repairs only missing manifest-declared workspace artifacts. The browser command will stop prebuilding the complete dependency graph before invoking that build. CI will run the deterministic contract benchmark and the browser runtime benchmark using this prepared path, retaining the runtime JSON as reviewable evidence.

## Prevention

- `test`: route-inventory drift check; invalid fixture is a router path absent from the inventory, valid fixture is a dynamic path with a canonical audited URL.
- `test`: route-owned interaction audit; an unreachable action, missing painted focus indicator, forced-color-hidden action, or reduced-motion-dependent outcome fails while an explicit read-only no-action presentation remains valid.
- `test`: axe WCAG tag fixture; a visible `Delete` label whose accessible name says only `Remove` fails, while an accessible name containing `Delete` passes.
- `test`: report-schema contradiction and eligible over-budget fixtures; a nearby ineligible over-budget report remains valid but explicitly informational.
- `test`: strict Node version evidence; malformed `v24beta` is rejected while `v24.10.0` and its supported prerelease form remain eligible.
- `test`: package-script/build-phase contract; unconditional recursive dependency build is invalid, manifest-based repair plus distribution validation remains valid.
- `test`: HTTPS proxy journey; spoofed forwarded headers outside the trusted path remain covered by the existing request-security suite, while the trusted path must emit HSTS, secure CSP, and the full production response-header contract without exposing embedded session material.
