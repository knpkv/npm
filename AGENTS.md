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

The remediation pass must implement the proposed guardrail with the defect fix whenever the proposal is stable. It must run the narrow rule fixtures first and then the complete lint/test gate. If implementation reveals that the proposal is brittle, record that evidence and replace it with the next most durable enforcement layer instead of silently dropping prevention work.

Public motion-ownership props must document their default, affected surfaces and presentations, sampling or update lifetime, exit behavior, and reduced-motion interaction. Cover both intrinsic and externally owned entry with browser-backed component examples.

### Versioning and Publishing

- **Semantic Versioning**: The project uses [Changesets](https://github.com/changesets/changesets) to manage versioning and generate changelogs.
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
- Decode untrusted JSON/body data with Schema helpers before assigning it to a
  domain type.
- Do not use raw host APIs in Effect code: no bare `process`, `fs`, `fetch`,
  `Date.now()`, zero-argument `new Date()`, `setTimeout`, or `setInterval`.
  Use `Stdio`, `FileSystem`, `HttpClient`, `Clock`, `Effect.sleep`,
  `Schedule`, and `effect/unstable/process` instead. Framework/UI boundaries
  may use host APIs only where the framework requires them.

Before enabling a production lazy authority-bearing runtime registry, a missing-record assertion is
not provider coverage. The composition suite must also seed an authorized action, cross the runtime
registry and executor projection, and assert the exact provider-call count and durable result.
