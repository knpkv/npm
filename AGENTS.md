# Gemini Code Understanding

This document provides a comprehensive overview of the `@knpkv` package collection, a monorepo for npm packages. It's designed to be a quick-start guide for developers and a context file for AI assistants.

## Project Overview

This is a `pnpm` workspace-based monorepo containing `npm` packages published under the `@knpkv` scope. The project is built with TypeScript and leverages [Effect-TS](https://effect.website) for robust, type-safe functional programming.

### Key Technologies

- **pnpm Workspaces**: Manages the monorepo structure.
- **TypeScript**: The primary programming language.
- **Effect-TS**: Used for functional programming patterns and error handling.
- **Vitest**: The testing framework.
- **ESLint and Prettier**: For code linting and formatting.
- **Changesets**: For versioning and changelog generation.
- **Nix and direnv**: For reproducible development environments.

### Repository Structure

The repository is organized as follows:

```
npm/
├── packages/          # Published npm packages
├── .github/          # CI/CD workflows for automated checks
└── scripts/          # Build and maintenance scripts
```

## Building and Running

The following commands are essential for working with this project.

### Installation

Install all dependencies using `pnpm`:

```bash
pnpm install
```

### Core Commands

- **Build all packages**:

  ```bash
  pnpm build
  ```

- **Run all tests**:

  ```bash
  pnpm test
  ```

- **Type-check all packages**:

  ```bash
  pnpm check
  ```

- **Lint all packages**:

  ```bash
  pnpm lint
  ```

- **Format all packages**:
  ```bash
  pnpm format
  ```

## Development Conventions

This project adheres to a strict set of development standards to ensure code quality and consistency.

### Coding Style

- **Functional Programming**: Code is written using functional programming principles, with a strong emphasis on the Effect-TS library.
- **Type Safety**: TypeScript's `strict` mode is enabled, and the `any` type is disallowed.
- **Modularity**: The monorepo is divided into individual packages, each with a specific purpose.

### Testing

- **Comprehensive Tests**: All packages are expected to have comprehensive tests written with `@effect/vitest`.
- **Test-Driven Development**: While not explicitly stated, the emphasis on testing suggests that TDD is a recommended practice.

### Review Findings Become Guardrails

Treat every confirmed review finding as both a defect to fix and a prevention opportunity. Before closing the finding, classify the most durable guardrail that would catch the same defect class earlier:

1. Prefer an `ast-grep` rule for mechanically recognizable source patterns.
2. Prefer an ESLint rule or configuration when scope-, binding-, control-flow-, or type-aware JavaScript/TypeScript semantics are required.
3. Add a focused automated test when the invariant is behavioral or integration-level.
4. Add a concise instruction to this file only when the invariant requires human or agent judgment.

Ship the applicable guardrail with the fix and prove it catches the original failure shape. If no stable automated guardrail is possible, record why in the review resolution instead of adding a brittle one-off rule.

Review agents must include a **Prevention** note with every finding. It should propose the concrete static-analysis matcher or lint rule when the defect is mechanically recognizable, otherwise name the behavioral test or repository instruction that should protect the invariant. A reviewer may recommend no new rule only with a short explanation of why the pattern cannot be detected reliably without excessive false positives.

Make every **Prevention** note implementation-ready:

- classify it as `ast-grep`, `ESLint`, `type-check`, `test`, `instruction`, or `none`;
- name the existing rule or configuration to extend before proposing a new one;
- identify the intended rule/configuration file and the source paths it should cover;
- sketch the matcher or invariant precisely enough for the remediation agent to implement it;
- name one invalid fixture that must fail and one nearby valid fixture that must continue to pass;
- call out likely false positives, generated/vendor exclusions, and any cases that still require judgment.

Manual acceptance checklists must contain one explicit item for every manually named SC flow; a grouped
row may cover several flows only when each is named, and a checklist cannot pass while any item is
`PENDING`, failed, or unresolved. Capability-boundary decisions must stay synchronized across the
owning plugin/barrels, runtime documentation, package README, source requirements, and governing ADR;
an alternate authorization path must not contradict a provider-enforced prerequisite.

The remediation pass must implement the proposed guardrail with the defect fix whenever the proposal is stable. It must run the narrow rule fixtures first and then the complete lint/test gate. If implementation reveals that the proposal is brittle, record that evidence and replace it with the next most durable enforcement layer instead of silently dropping prevention work.

GitHub workflow guards must compare external action owner/repository names
case-insensitively and normalize action input names before inspecting them. In
`pull_request_target`, treat every pull-request-derived
revision, including `head.sha`, `head.ref`, `github.head_ref`, and
`merge_commit_sha`, plus `head.repo.full_name` checkout repositories, in dot or
static indexed syntax, as attacker-controlled when the job can access repository
credentials. Match the `head.repo` expression prefix so composed owner/name
repository inputs cannot bypass the guard. Treat effective workflow/job
`id-token: write`, any token permission with `write` access, and `write-all` as
credential authority too. On `pull_request_target`, omitted effective
permissions conservatively imply privileged token authority; an explicit
read-only permission map remains non-authoritative;
OIDC-bearing jobs must not checkout or build pull-request revisions. After an
attacker-controlled checkout, conservatively treat every later `run`, local
action, or external action step as capable of executing the workspace; a
metadata-only external action needs explicit human judgment before any narrow
allowlist exception is added.
Credential authority must follow static local reusable-workflow calls
transitively, including `secrets: inherit`; reject cycles and missing local
callees. Credential- or OIDC-bearing remote and dynamically constructed
reusable-workflow references must emit an explicit-review diagnostic unless a
repository-maintained reviewed allowlist proves them metadata-only. Parse `${{ ... }}` delimiters without treating
`}}` inside quoted GitHub expression strings as the end of the expression.
Treat mechanically recognizable `git checkout`, `git switch`, and
`git reset --hard` commands that reference pull-request head/ref or merge
expressions in their parsed revision operand as attacker-controlled worktree
transitions. Account for value-taking global Git options such as `-C` and `-c`;
metadata-only logging of the same expressions must remain allowed.
Manual local reusable-workflow calls using `secrets: inherit` require the same
main-ref condition and protected environment as direct long-lived secret use.
Workflow action-pin validation must traverse every reachable repository-local
action manifest, regardless of its directory, reject missing or cyclic local
action references, and apply immutable external-reference rules transitively;
Docker action `runs.image` references must use a digest, while a local
`Dockerfile` remains subject to explicit base-image review.

External-resource tests must register scope cleanup immediately after successful creation, before validating or transforming the returned resource identity.

Runtime startup tests must observe the natural supervised lifecycle path with synchronization primitives; do not add production control-flow options solely to make tests deterministic.
Lifecycle polling, admission, and drain sequencing shared by multiple workers must live in one private runtime helper.
Sandbox startup must not report readiness while legacy unauthenticated
containers may remain active; transient Docker unavailability and reconciliation
failures must retry under the supervised startup lifecycle until shutdown is
confirmed. When the database proves there are no legacy unauthenticated rows,
Docker may remain unavailable without blocking web readiness and ordinary
maintenance must retry in a supervised background loop. Query terminal as well
as active legacy rows; every legacy row must discover every container bearing
its `codecommit.sandbox.id` label and block readiness until all discovered and
persisted containers are stopped. Activate the owner bootstrap token's expiry and advertise or open its
URL only after the authenticated listener layer has built successfully.

Public motion-ownership props must document their default, affected surfaces and presentations, sampling or update lifetime, exit behavior, and reduced-motion interaction. Cover both intrinsic and externally owned entry with browser-backed component examples.

Security-sensitive canonical-payload documentation and code examples must name the persisted representation and every identity input. Raw provider secrets must not be described as durable payload fields, and idempotency examples must include every identity component used by production.

Security documentation in `.specs/**` and package READMEs must distinguish server-private provider locators from normalized or client-visible representations. Name a bucket, key, ARN, token, or similar coordinate only with its private boundary, and list the safe fields that may cross normalization or HTTP boundaries.
Every provider fixture-locator list must classify each coordinate as server-private or name its safe normalized/authenticated boundary, persisted representation, and prohibited emission surfaces.
For `packages/control-center/README.md`, `packages/control-center/src/api/**`, and `packages/control-center/src/client/**`, an identifier that crosses an authenticated HTTP route or browser storage boundary is client-visible and must not be described as server-private. In particular, document `pluginConnectionId` as a normalized authenticated client-visible identifier when it appears in typed routes or cross-tab storage, including that persisted representation and its unauthenticated/public emission prohibition; keep raw provider site locators and credentials server-private. Generated and vendor documentation are excluded, while identifiers that never cross a transport boundary still require judgment.

### Versioning and Publishing

- **Semantic Versioning**: The project uses [Changesets](https://github.com/changesets/changesets) to manage versioning and generate changelogs.
- **Feature Classification**: In `.changeset/*.md`, exported or user-visible functionality added under publishable `packages/*/src` or `packages/*/package.json` requires a `minor` bump. This includes additive fields in exported interfaces and schemas, even when their producer or decoder is implemented privately. A new public option or application workspace is not a patch; dependency-only stabilization may remain a patch. Private, generated, and vendor packages are excluded, while internal-only features still require judgment.
- **Automated Releases**: The CI/CD pipeline automates the release process. When a version PR is merged, the packages are automatically published to `npm`.

### Agent Management

- **Sync Agent Commands**:
  ```bash
  npx @iannuttall/dotagents
  ```

### Contribution Guidelines

1.  Create changes with proper documentation and tests.
2.  Add a changeset by running `pnpm changeset`.
3.  Commit your changes.
4.  The CI will create a version PR automatically.
5.  Merge the version PR to publish the changes.

<!-- effect-reference:start -->

## Effect Source Reference

The Effect beta source is available in this workspace under `repos/effect`. Treat `repos/effect` as vendored reference material: read it for current beta APIs, tests, module structure, and local idioms, but do not import from it or edit it unless the task explicitly asks to update the subtree.

Before writing Effect code, read `repos/effect/LLMS.md` and use `rg` in `repos/effect/packages` to verify current beta APIs.

Recommended checks:

- `rg "Context.Service" repos/effect/packages`
- `rg "NodeHttpServer" repos/effect/packages`
- `rg "Clock.currentTimeMillis" repos/effect/packages`

The subtree is maintained from the `effect-smol` remote. See `docs/dependency-maintenance.md` for the exact `git subtree pull --prefix=repos/effect effect-smol main --squash` workflow and version-alignment steps.

Use Effect Platform modules and `effect/unstable/process` for runtime access. Do not read `process` through `globalThis.process` or bare `process.*`.

<!-- effect-reference:end -->

## Effect Static Checks

Effect-specific agent guardrails span the syntactic rules in
`ast-grep/rules/effect` and the scope- or binding-aware local rules in
`eslint-local-rules.cjs`. Run `pnpm lint` as the complete gate; `pnpm lint:ast`
covers only the ast-grep subset. See `docs/effect-static-checks.md` before
adding, weakening, or working around these rules.

When writing Effect code:

- Prefer `Context.Service` class syntax and explicit `Layer.effect` /
  `Layer.succeed` layers.
- Bind services before calling methods inside generators:
  `const service = yield* SomeService`.
- In `HttpApiBuilder.group`, acquire stable application services in the group callback before registering handlers so the resulting layer closes its requirements. Resolve only genuinely request-scoped services, such as `CurrentSession`, inside the per-request handler.
- Use tagged domain errors (`Data.TaggedError` or `Schema.TaggedErrorClass`) and
  keep failures in the typed error channel.
- In `packages/control-center/src/server/governance/internal/execution-store`, durable provider
  outcome decoding, canonical verification, replay-integrity checking, transition construction,
  transaction ownership, and fold insertion must live in one shared private fold module. Dispatch
  and reconciliation modules may supply source-specific outcome material, but must not duplicate
  the fold state machine or persistence boundary.
- In `packages/control-center/src/server/persistence/repositories/delivery-graph/read.ts`, keep
  relationship bounding and node, projection, claim, and evidence closure hydration in the private
  `hydrateRelationshipClosure` helper; slice branches may supply only identities, bounds, and their
  projection-selection policy.
- Decode untrusted JSON/body data with Schema helpers before assigning it to a
  domain type.
- Model provider revision and reconciliation-locator parsing as Schema
  transformations (including template-literal parsers for structured locators);
  reserve manual URL/cursor extraction for opaque transport pagination.
- When advertised plugin capabilities change, update current module and service
  documentation in the same change while keeping historical-descriptor comments
  explicit about their older capability surface. Check the plugin's `index.ts`,
  every ancestor barrel that exports it, public runtime JSDoc, and package README
  section; retained public identifiers and historical documentation still require
  compatibility judgment. Generated and vendor barrels are excluded.
- When PR-review sandbox naming or reconciliation ownership changes in
  `packages/control-center/src/server/agent/internal/PrReviewSandboxSession.ts`,
  update `packages/control-center/README.md` and
  `packages/control-center/docs/agentic-pr-review.md` in the same change, and
  append an amendment to the governing ADR when earlier rationale changes.
  Current docs must describe the server-private compact workspace-scoped prefix,
  its 63-character sbx limit, and state that foreign-workspace and legacy names
  are not automatically removed; a claim that startup removes all
  `cc-pr-review-*` names is invalid. Keep the focused sandbox-session test
  proving that the invalid full-UUID shape exceeds the limit while the bounded
  compact name and foreign-workspace fixture pass. Generated and vendor docs are
  excluded. Clearly historical implementation plans may remain unchanged, but
  ADR history requires an amendment rather than a silent rewrite.
- Do not use raw host APIs in Effect code: no bare `process`, `fs`, `fetch`,
  `Date.now()`, zero-argument `new Date()`, `setTimeout`, or `setInterval`.
  Use `Stdio`, `FileSystem`, `HttpClient`, `Clock`, `Effect.sleep`,
  `Schedule`, and `effect/unstable/process` instead. Framework/UI boundaries
  may use host APIs only where the framework requires them.
- The sole raw Node filesystem exception is
  `packages/codecommit-core/src/CacheService/internal/PrivateDatabasePathNode.ts`:
  it is an audited descriptor boundary that must retain `O_NOFOLLOW` directory
  and database handles through `fchmod` and verify path identity before return.
  Do not broaden its ast-grep exclusion or move ordinary filesystem work into it.
- `ChildProcess.make` options that set `env` must also state `extendEnv`; it
  defaults to falsy, so `env` alone replaces the child environment and drops
  `PATH`. `local-rules/require-explicit-child-process-env-inheritance` is the
  single enforcement layer, deliberately: deciding whether a receiver named
  `ChildProcess` is really Effect's module needs binding resolution, so a
  syntactic ast-grep companion reported foreign APIs of the same shape and was
  removed rather than narrowed. The rule enforces that the choice is stated, not
  that it is correct — two things still need judgment. With `extendEnv: false`, `env` must
  itself carry everything the child needs, including `PATH`. With
  `extendEnv: true`, inherited variables that outrank the ones you pass must be
  cleared: a spawn scoped to an explicit AWS profile has to drop every ambient
  environment credential provider, which means the static keys _and_ the
  web-identity variables, plus both `AWS_REGION` and `AWS_DEFAULT_REGION`, since
  the AWS credential chain resolves environment variables above profile
  configuration. Clear each family completely — clearing one variable of a pair
  is worse than clearing neither, because which one leaks then depends on the
  caller's shell. Use `ChildEnv.profileScopedEnv` in the `codecommit` packages
  rather than rebuilding the exclusion list; it documents which variables are
  deliberately left alone and why.
- When CodeCommit TUI changes add an AWS operation, Git transport behavior, or a
  required local executable, update `packages/codecommit/README.md` in the same
  change with the corresponding IAM action and runtime prerequisite. Pure
  presentation changes do not require a capability update.
- Keep sandbox capability boundaries synchronized across
  `packages/codecommit-core/README.md`, `packages/codecommit/README.md`, and the
  owning policy, service, projection, and security tests. The invariant is:
  validate before persistence and Docker execution; require immutable image
  digests, migrating only the former built-in `codercom/code-server:latest`
  default to the current pinned digest during load; reserve code-server
  credential variables; accept only existing
  canonical children of the physical `~/.codecommit/sandbox-volumes` directory
  mounted below `/home/coder` or the exact `/tmp/.local/share/code-server`
  runtime data subtree; keep built-in setup presets unprivileged; persist the
  generated access password only in an owner-only `0700` cache directory and
  `0600` database after rejecting symbolic-link paths, and expose it only
  through the authenticated, non-cacheable
  single-sandbox route; map the
  non-root container identity to the workspace owner (repair root-owned clones
  to a fixed non-root identity); drop all capabilities and publish only on
  loopback; keep sandbox browser origins on the alternate loopback hostname so
  the host-only owner cookie cannot reach sandbox ports; advertise the Vite
  origin during development while proxying bootstrap/API requests through the
  exact backend origin; redact
  credentials and workspace paths from list/event projections; and recreate
  legacy passwordless containers. Pass container environment, including the
  generated password, through a protected pipe-backed Docker env file rather
  than process arguments; environment names must be portable identifiers and
  values must be single-line so env-file parsing cannot inject variables.
- Keep CodeCommit merge capability copy synchronized across
  `packages/codecommit/src/tui/ui/**`, `packages/codecommit/README.md`, and
  `packages/codecommit-core/README.md`. The provider request pins the reviewed
  source commit, while destination validation is preflight-only because
  CodeCommit exposes no destination compare-and-set. Copy must not promise that
  a three-way merge uses the reviewed base if the destination advances after
  preflight. Generated and vendor documentation are excluded; providers with a
  real destination compare-and-set still require capability-specific judgment.
- Keep CodeCommit review-publication terminology synchronized across
  `.changeset/*.md`, `packages/codecommit/README.md`, and the publication schema.
  CodeCommit has no native file-comment target: describe file-scoped findings as
  file-anchored PR comments unless the schema and provider operation actually add
  a distinct capability. Generated and vendor changelogs are excluded; provider
  terminology still requires judgment.
- Keep CodeCommit editor documentation synchronized with exact-head behavior in
  `packages/codecommit/README.md` and `packages/codecommit/src/tui/review-session.ts`:
  after-side findings may open at their line, before-side findings must not apply
  a base line to the head file, and deleted files are not launchable unless a
  separate verified base artifact is explicitly materialized. Also document
  `codecommit:GetBlob` as mandatory whenever exact-line publication validation
  reads provider blobs, even when local checkout powers the displayed diff.

Before enabling a production lazy authority-bearing runtime registry, a missing-record assertion is
not provider coverage. The composition suite must also seed an authorized action, cross the runtime
registry and executor projection, and assert the exact provider-call count and durable result.
