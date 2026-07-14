# Effect Static Checks

This repo uses static checks as agent guardrails for Effect code. The goal is to
catch high-confidence mistakes that agents commonly introduce without turning
style preferences into noisy CI failures.

## Commands

- `pnpm lint` runs ESLint and ast-grep.
- `pnpm lint:ast` first runs the rule cases in `ast-grep/tests`, then scans with
  the rules from `sgconfig.yml`, including the Effect-specific rules in
  `ast-grep/rules/effect` and TypeScript-wide rules in
  `ast-grep/rules/typescript`.
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
- Do not silently discard `Effect.runPromise` rejections. The import-aware local
  ESLint rule recognizes namespace aliases, named imports, empty handlers,
  `void` returns, and rejection callbacks passed to either `catch` or `then`.
- Use Effect platform services at runtime boundaries: no raw `fs`, raw process
  access, raw `fetch`, raw crypto, or raw timer APIs in package/source Effect
  code.
- Use Schema JSON codecs at API spec generation boundaries: no raw
  `JSON.parse`/`JSON.stringify` in API-client regeneration scripts.
- Keep API-client regeneration failures typed: no native `Error` construction or
  constructor-based narrowing inside those Effect flows; use tagged errors and
  preserve original failures in `cause`.
- Inspect unknown errors and defects with Effect-native predicates: no direct
  `instanceof`, `"message" in value`, or `"_tag" in value` checks in
  TypeScript.
- Avoid `globalThis` in TypeScript; use explicit runtime globals only
  at boundary code or Effect services where available.
- Keep service access readable: bind `const service = yield* Service` before
  calling service methods.
- Give named Effect operations a stable trace identity with `Effect.fn`. The
  Control Center ast-grep rule covers arrow functions, function expressions,
  and function declarations that directly return `Effect.gen`, a piped
  `Effect.gen`, or `Effect.suspend`.
- Keep indefinite retry controllers iterative inside one `Effect.fn`. Direct
  self-recursion keeps each parent tracing span open until the recursive tail
  exits and can grow an unbounded active-span chain; a dedicated rule rejects
  that shape, including explicitly typed declarations.
- In Control Center HTTP groups, acquire stable application services once in
  the `HttpApiBuilder.group` callback. The binding-aware local ESLint rule
  rejects those services inside `.handle(...)` callbacks while allowing the
  request-scoped `CurrentSession` service there.
- Stay on Effect v4 APIs: use `Context.Service`, `Effect.catch`, and
  `Effect.gen({ self: this }, ...)` instead of stale v3 forms.
- Preserve CLI failure semantics: when a CLI entrypoint formats command failures
  and then re-fails, call `NodeRuntime.runMain` with
  `{ disableErrorReporting: true }` to avoid duplicate runtime reports.
- Keep attachment command validation precise: local placeholder/file validation
  is not a remote API error, and optional document content should be modeled
  without non-null assertions.
- Keep CLI error formatters total: unknown-object formatting must not be able to
  throw while reporting the original failure.

## Hard TypeScript Guardrails

Type assertions are banned. Do not use `value as Type`, `value as const`, double
assertions such as `value as unknown as Type`, or any variant of `as` to
override the checker. Model the value, narrow it, decode it, or use
`satisfies`.

Control Center public HTTP contracts must use purpose-built canonical wire
schemas instead of `Schema.NumberFromString`, whose JavaScript coercion accepts
ambiguous forms such as whitespace, signs, exponents, and hexadecimal. An
import-aware local ESLint rule follows namespace and named imports from Effect,
including computed access, destructuring, and re-exports, while allowing local
schema modules that happen to use the same member name.

Awaited cleanup immediately before rethrowing a caught failure must preserve
both causes when cleanup can fail. The ast-grep rule rejects the unsafe direct
`await cleanup(); throw originalFailure` shape; aggregate the setup and cleanup
failures instead.

Reviewed Control Center server entrypoints require explicit exported return
types. This check is deliberately scoped to `Auth.ts`, `TerminalRecovery.ts`,
and `ControlCenterServer.ts`; expand the file list only after annotating and
reviewing another boundary.

Built package validation also compiles negative consumers for internal
auth/persistence layer factories and scans the emitted public declaration
chain. This protects the package boundary against a source barrel accidentally
making database implementation details importable.

The `rly` registry check rejects project-owned `.d.ts` shims; framework and
test globals belong in the relevant `tsconfig` `types` list. Its packed-package
test walks the declaration symbols reachable from each public diff export and
rejects types originating in `@pierre/diffs`, including package subpaths,
without treating private renderer/worker declarations as public API.

## Agent Guidance

When writing or refactoring Effect code:

- Inspect `repos/effect` before changing Effect-heavy code or adopting a new
  beta API.
- Prefer `Context.Service` class syntax plus explicit `Layer.effect` or
  `Layer.succeed` layers.
- Accept both `Data.TaggedError` and `Schema.TaggedErrorClass`; use schema-backed
  errors when runtime encoding, API responses, or transport boundaries matter.
- Preserve unknown failure details in tagged error `cause` fields. When code
  must inspect an unknown failure, use `Predicate.isError`,
  `Predicate.hasProperty`, or `Predicate.isTagged`.
- Decode untrusted data with `Schema.decodeUnknownEffect` or related Schema
  helpers before assigning it to a domain type. Use `Schema.fromJsonString` and
  `Schema.Json` for JSON text boundaries instead of raw `JSON.parse` or
  `JSON.stringify`.
- Use `Clock`, `DateTime`, platform `FileSystem`, `HttpClient`, `Stdio`, and
  `effect/unstable/process` in Effect code. Use `Crypto.Crypto` for secure
  random bytes, UUIDs, and digests; use `Random` only for non-security
  randomness. Keep direct host APIs at framework or UI boundaries only when the
  framework requires them.

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
