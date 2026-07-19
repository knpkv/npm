# Control Center — Phase 4 implementation plan

## Status

Status: **Phase 4 approved — Phase 5 implementation authorized on 2026-07-13**

This index turns the approved [requirements](./requirements.md) and [design](./design.md) into reviewable, independently passing commits. The plan is split by milestone so implementation detail does not accumulate in one oversized file.

The source-backed status and smaller post-checkpoint delivery sequence are maintained in
[remaining work](./remaining-work.md). The milestone files below remain the normative capability
definitions; the remaining-work specification splits their unfinished portions into faster vertical
slices without weakening their security or authority boundaries.

## Milestones

| Order | Milestone                                                     | Commit IDs | Exit evidence                                                                                 |
| ----- | ------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| 1     | [Repository and rly](./plan/01-rly.md)                        | R01–R16    | Published-package fixture can install and render rly without Control Center                   |
| 2     | [Authenticated tracer slice](./plan/02-tracer-slice.md)       | T01–T12    | Pairing → fake plugin → durable release → API/SSE → Overview → preview/full works             |
| 3     | [Delivery graph and work views](./plan/03-delivery-core.md)   | D01–D09    | Six Jira items, evidence/readiness, governed repair, Active work, Items, Timeline             |
| 4     | [Production integrations](./plan/04-integrations.md)          | I01–I12    | Five isolated adapters pass the shared partial-failure contract suite                         |
| 5     | [Full service experiences](./plan/05-service-pages.md)        | S01–S07    | Every canonical service route is actionable and context-preserving                            |
| 6     | [Diffs and first-class agents](./plan/06-agents-and-diffs.md) | A01–A12    | Complete PR diff, Effect AI CLI providers, and durable sandboxed agent review pass acceptance |
| 7     | [Hardening and delivery](./plan/07-hardening.md)              | H01–H08    | Security, recovery, accessibility, performance, docs website, audits, and full gates pass     |

The order is normative. A later commit may be pulled earlier only if its dependencies remain acyclic and the revised plan is approved before implementation.

## Atomic commit protocol

Every plan item is one intended commit. For each item:

1. Start from a clean reviewed predecessor. Preserve unrelated user changes.
2. Implement only the named behavior and its directly required refactor.
3. Add tests, public documentation/JSDoc, and generated artifacts in the same commit. A changed existing published package receives a changeset with its public change. Each new, not-yet-published package keeps one initial minor changeset that is updated as its first public surface grows, avoiding dozens of pre-release changelog fragments.
4. Run the focused gate named by the item plus format/lint/type checks for every touched package. Generated-output drift is a failure.
5. Create the commit, inspect `git show --stat --check` and the complete diff, then run an independent standards/spec review against that commit. Every finding must include a **Prevention** classification, the existing rule/configuration to extend, target and covered paths, matcher/invariant, reject/allow fixtures, exclusions, and false-positive boundary.
6. If review finds a blocker, correct and re-run the same gates before advancing. Every finding includes an implementation-ready **Prevention** proposal; ship its stable ast-grep, ESLint, type-check, test, or instruction guardrail with the fix, or record why automation would be brittle. Do not stack new feature scope on an unaccepted predecessor.
7. Run the milestone exit journey before starting the next milestone. Run the repository-wide gate at H08.

Commits must not leave dead routes, temporarily export vendor shapes, bypass typed errors, weaken tests, or rely on a future commit to make the current build pass. Before schema stability, database changes update one exact unstable snapshot and may require recreating local data. After the first released schema, migrations are forward-only. Public package extensions land in their owning package before Control Center consumes them.

## Shared verification vocabulary

- **Package gate:** build, check, lint, unit/DOM tests, export test, and generated-output check for every touched package.
- **Server gate:** Effect unit tests plus fresh-database HTTP integration tests with deterministic layer teardown.
- **Browser gate:** repository-managed Chromium, `workers: 1`, `fullyParallel: false`, seeded fake providers, deterministic server/context/process teardown.
- **Security gate:** hostile input and secret-canary tests plus zero-vendor-call assertions for rejected governed actions.
- **Review gate:** standards, approved requirement, public API, package-boundary, migration, failure-mode, accessibility, and test-adequacy review of the exact commit, including implementation-ready Prevention proposals and evidence that accepted stable guardrails ran their narrow reject/allow fixtures before the complete gate.

## Cross-cutting rules

- Read `repos/effect/LLMS.md` and verify every beta API in `repos/effect/packages` immediately before the first Effect implementation commit and whenever the pinned Effect version changes.
- All untrusted input crosses an Effect Schema boundary. Expected failures stay tagged in the typed error channel.
- Every integration, service page, and agent-provider commit must use the T04 SecretStore and T06 request/content/media boundaries immediately and extend their hostile-input/secret-canary suites for its new data shapes; later hardening may tighten these foundations but never introduce them retroactively.
- Effect code uses services for clock, process, filesystem, HTTP, and scheduling; UI/framework boundaries are the only documented host-API exceptions.
- `@knpkv/rly` remains presentation-only. Control Center presenters derive authorization, freshness, relationships, readiness, and release identity before constructing rly props.
- Prototype code remains an isolated visual fixture until the applicable production route gates pass and H07 records parity evidence. Production runtime never imports it.
- Playwright and browser-backed Storybook work never run with unbounded workers.
- No implementation commit is pushed independently. The completed reviewed series is published as one draft PR in H08, then CI and review comments are monitored to completion.

## Acceptance ownership

| Success criteria                                          | Primary proving commits                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| SC7.1 fresh installation                                  | T04–T10, I11                                                        |
| SC7.2–SC7.5 portfolio, preview, routing, six-item clarity | T07–T10, D01–D07                                                    |
| SC7.6 relationship repair                                 | D01–D04                                                             |
| SC7.7 pipeline retry                                      | D03, I10, S05                                                       |
| SC7.8 Active work                                         | D06                                                                 |
| SC7.9 Jira lifecycle                                      | I04–I05, S02                                                        |
| SC7.10 complete diff and agent review                     | I01–I03, R15, A01–A12                                               |
| SC7.11 agent isolation                                    | A03–A05, A09–A12                                                    |
| SC7.12 governed mutation                                  | T05, D03–D04 and every adapter action execution/reconciliation test |
| SC7.13 full service routes                                | I12, S01–S07                                                        |
| SC7.14 plugin partial failure                             | T05, I03/I05/I07/I09/I10, I11                                       |
| SC7.15 live recovery                                      | T08, T10, D04–D07, A03–A07                                          |
| SC7.16 restart and corruption                             | T03/T12, D09, A03/A11/A12, H01–H02                                  |
| SC7.17 LAN security                                       | T04, H03                                                            |
| SC7.18 sandbox containment                                | A11–A12                                                             |
| SC7.19 content and secret safety                          | T04/T06, every adapter, A06–A12, H03                                |
| SC7.20 accessibility and presentation                     | R04–R16, I12, every page commit, H04                                |
| SC7.21 performance and bounds                             | T11, A01–A03, H05                                                   |
| SC7.22 design-system reuse                                | R01–R16, T01, S01, H06                                              |
| SC7.23 complete validation                                | H08                                                                 |
| SC7.24 local Effect AI wrappers                           | A06–A09, H08                                                        |
| SC7.25 new-package documentation site                     | R16, A06–A07, H06                                                   |

## Approval boundary

Approving this plan authorizes Phase 5 implementation in the order above. It does not authorize real vendor mutations, deployment, package publication, or merging the PR. Tests use fake adapters/providers except for the user-required, deliberate local cdx smoke defined by SC7.24; that command may invoke the already-authenticated local Codex only when run explicitly and remains read-only, ephemeral, bounded, and outside automatic CI/pre-commit.
