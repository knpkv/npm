# Effect Static Checks

This repo uses static checks as agent guardrails for Effect code. The goal is to
catch high-confidence mistakes that agents commonly introduce without turning
style preferences into noisy CI failures.

## Commands

- `pnpm lint` runs ESLint and ast-grep.
- `pnpm lint:ast` runs the Effect-specific ast-grep rules in
  `ast-grep/rules/effect`.
- `pnpm lint:eslint` runs the shared ESLint config and local ESLint rules.
- `pnpm skills:check` verifies product-local agent skills are synced from
  `packages/agent-skills/skills`.

## Hard Effect Guardrails

Use ast-grep for syntactic patterns that are precise without type information:

- Keep failures in the Effect error channel: no `throw` or `try/catch` inside
  `Effect.gen`.
- Use typed domain errors: no native `Error` subclasses and no bare
  `new Error(...)` inside Effect generators.
- Keep Effect composition inside Effect code: no `Effect.runPromise`,
  `Effect.runSync`, or `Effect.runFork` inside `Effect.gen`.
- Use Effect platform services at runtime boundaries: no raw `fs`, raw process
  access, raw `fetch`, or raw timer APIs in package/source Effect code.
- Keep service access readable: bind `const service = yield* Service` before
  calling service methods.
- Stay on Effect v4 APIs: use `Context.Service`, `Effect.catch`, and
  `Effect.gen({ self: this }, ...)` instead of stale v3 forms.

## Agent Guidance

When writing or refactoring Effect code:

- Inspect `repos/effect` before changing Effect-heavy code or adopting a new
  beta API.
- Prefer `Context.Service` class syntax plus explicit `Layer.effect` or
  `Layer.succeed` layers.
- Accept both `Data.TaggedError` and `Schema.TaggedErrorClass`; use schema-backed
  errors when runtime encoding, API responses, or transport boundaries matter.
- Decode untrusted data with `Schema.decodeUnknownEffect` or related Schema
  helpers before assigning it to a domain type.
- Use `Clock`, `DateTime`, platform `FileSystem`, `HttpClient`, `Stdio`, and
  `effect/unstable/process` in Effect code. Keep direct host APIs at framework
  or UI boundaries only when the framework requires them.

## Non-Goals

Some Effect preferences remain documentation instead of hard checks because they
are easy to overfit:

- Broad `from "effect"` import migration. Upstream Effect checks this, but this
  repo currently has many valid existing imports and should migrate deliberately.
- JavaScript `Date` values as domain data. The hard check targets raw
  wall-clock reads (`Date.now()` and zero-argument `new Date()`) inside Effect
  generators, not parsing or formatting an already-known instant.
- `Effect.tryPromise` object-shape policy. Prefer a `catch` mapper to a typed
  error, but ast-grep object-property matching is not robust enough here for a
  hard rule.
