# Effect Idiomaticity Refactor

This refactor aligns the workspace with the Effect v4 APIs and lifecycle
semantics used by the pinned `4.0.0-beta.98` release.

## Source of truth

- The workspace dependencies are `4.0.0-beta.98`.
- `repos/effect` is currently one release behind at beta.97, so it remains useful
  for local navigation but is not sufficient for availability checks in this
  refactor.
- API availability was verified against the exact
  `effect@4.0.0-beta.98` upstream tag, not only a moving checkout.
- The public Effect checkout is currently beta.102. Its `HEAD` may inform
  forward-looking style, but this refactor must not depend on APIs absent from
  beta.98.

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
