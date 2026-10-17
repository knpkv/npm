# Effect Idiomaticity Refactor

This refactor aligns the workspace with the Effect v4 APIs and lifecycle
semantics used by the pinned `4.0.0` release.

## Source of truth

- The workspace dependencies are `4.0.0`.
- `repos/effect` is pinned to the exact canonical `effect@4.0.0` release
  tag and must not follow `main`.
- API availability was verified against the exact
  `effect@4.0.0` upstream tag, not only a moving checkout.
- A moving upstream checkout may inform forward-looking style, but this
  workspace must not depend on APIs absent from 4.0.0.

## Refactor guidance

### 1. Preserve the Effect failure model

- Recover expected typed failures with `Effect.catch`, `Effect.catchTag`,
  `Effect.catchIf`, `Effect.mapError`, or `Effect.orElseSucceed`.
- Do not use `Effect.catchCause` to turn interruption or defects into fallback
  success. Cause-level recovery must explicitly preserve interruption and
  unexpected defects.
- Wrap rejected promises in a tagged error at the promise boundary. Do not leave
  `unknown` in an intermediate error channel.
- Decode browser, transport, and persisted inputs with Effect, `Result`, or
  `Option` Schema decoders. Throwing synchronous decoders are reserved for
  trusted construction.
- Give every `Effect.fn` callback an explicit or contextual parameter type.

Confirmed repairs include the Rly visual classifier, Control Center live-event
wake pulls and database startup, CodePipeline SDK calls, PR-review execution,
client Timeline filters, and review-dismissal inputs.

### 2. Make ownership and finalization explicit

- Long-lived work created by a layer uses `Effect.forkScoped`.
- Work started by a request or callback but owned by the application uses
  `Effect.forkIn` with a scope captured by the owning service or runtime.
- `Effect.forkDetach` is not an application-lifecycle mechanism.
- OAuth callback servers are scoped acquisitions. Cleanup is registered
  immediately after acquisition and runs when browser opening, waiting,
  exchange, or the parent fiber fails or is interrupted.
- Executable entrypoints use `NodeRuntime.runMain` or `BunRuntime.runMain` so
  signals, exit status, teardown, and error reporting remain runtime-owned.
- React effects that start promise-backed Effect work pass an `AbortSignal` and
  abort it during cleanup.

Confirmed repairs include CodeCommit server workers and TUI actions, Jira and
Confluence OAuth callback servers, the CodeCommit web entrypoint, Control Center
session hydration, and any other production `forkDetach` call.

### 3. Prefer the matching Effect abstraction

- Use `Cache` for bounded keyed lookup caching and concurrent miss
  deduplication. Construct it once in the owning layer.
- Use `Schedule` plus `Effect.repeat` for polling whose semantics are “run one
  attempt, then wait and repeat.”
- Read time through `Clock` inside Effect workflows and pass the resulting
  instant to pure helpers.
- Compose dependent layers with `Layer.provide` or `Layer.provideMerge`.
  `Layer.mergeAll` is only for independent siblings.
- Use `Effect.fn("Module.operation")` for reusable public and non-trivial
  internal Effect functions.

Confirmed repairs include the Confluence user cache, authorized-share polling,
Atlassian OAuth expiry calculations, and the CodeCommit, Jira Clockify, and
Atlassian CLI layer graphs.

### 4. Turn review findings into guardrails

Before this refactor, the Effect language service reported diagnostics while
`tsconfig.base.jsonc` prevented errors and warnings from failing `tsc` and hid
message-level suggestions. The refactor therefore:

1. resolve or narrowly document every production error and warning;
2. run diagnostics over every Effect-using package rather than relying on a
   root project that covers only part of the workspace;
3. make Effect errors and warnings affect the check exit status;
4. keep suggestion diagnostics visible for agent guidance while allowing the
   explicitly configured suggestion exit policy;
5. add focused ast-grep, ESLint, or behavioral tests for the confirmed defect
   classes.

The durable checks should cover:

- silent cause recovery;
- globally detached production fibers;
- throwing Schema decoders in Control Center client code;
- manual sleep polling in client Effects;
- untyped `Effect.try` / `Effect.tryPromise` catch results;
- missing React cleanup signals;
- dependent siblings in `Layer.mergeAll` and chained `Effect.provide`;
- direct wall-clock reads in Atlassian auth workflows;
- named reusable Effect functions without `Effect.fn`.

## Acceptance gates

- The standalone Effect diagnostics scan reports no unexplained errors or
  warnings in workspace source.
- Focused guardrail fixtures fail for each original invalid shape and retain a
  nearby valid fixture.
- Lifecycle tests prove interruption/finalization for detached workers and OAuth
  callback servers.
- Cache tests prove same-key concurrent deduplication and bounded/expiry
  behavior.
- Polling tests prove normal cadence, wake-up behavior, completion, and absence
  of hot loops.
- `pnpm lint`, `pnpm check`, and `pnpm test` pass.
- A second independent Luna review reports no unresolved material findings
  before the pull request is opened.

## Review conventions

New and changed code follows these rules. The Effect Conventions check (`.macroscope/check-run-agents/effect-conventions.md`)
reviews pull requests against this section and reads it from this file, so a change here changes the check.
Untouched code that predates a rule is not a finding.

### Imports

- Both styles are accepted: named imports from the bare `"effect"` package and namespace imports from subpaths
  such as `import * as Effect from "effect/Effect"`. Within one file, use one style.
- Flag a changed import that introduces the other style into a file that consistently uses one. Do not flag a
  file that already mixes them, and never ask to convert existing imports: import churn is not a fix.
- Import Effect modules from their stable paths (`effect/http`, `effect/sql`, `effect/process`). Flag imports
  from `repos/effect`.

### Errors

- New failures are `Schema.TaggedError` classes with structured fields. `Data.TaggedError` is legacy: flag it on
  a changed line that declares a new error, not on untouched declarations.
- One named, tagged error per failure, so a caller can tell failures apart and handle the one it cares about.
  Flag `new Error("…")`, a thrown value, a string or `unknown` in the error channel, and one generic error reused
  for unrelated failures where callers need to distinguish them.
- Keep failures in the typed error channel. Wrap a rejected promise or a thrown library error in a tagged error at
  that boundary.

### No quiet fallbacks

- Flag recovery that hides a failure the caller or user should see: `Effect.orElseSucceed`, `Effect.catch` or
  `catchTag` returning a default, `Option.getOrElse` or `?? []` applied to a failed read, an empty list shown for
  an unreadable source, or a log line in place of a typed failure.
- A fallback is correct when the failure is expected and the fallback is the intended behavior, and the reader can
  still tell it happened, for example a visible warning naming what was dropped. Say which case the code is in
  before flagging.

### Types and boundaries

- No `any`, explicit or implied through an untyped parameter or a widening cast. Prefer a real type or `unknown`
  followed by decoding.
- Validate at the boundary and trust the type after: decode HTTP bodies, browser storage, environment, files,
  provider responses and persisted rows with Schema where they enter, then pass the decoded type. Flag untrusted
  data assigned to a domain type without decoding, and flag re-validation or casts deeper in, which signal the
  boundary is missing.
