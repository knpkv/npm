# Governed CodePipeline Actions, Logs, and Artifacts

## Overview

Issue [#207](https://github.com/knpkv/npm/issues/207) delivers milestone M3.4
of the Control Center roadmap. It extends the existing bounded CodePipeline
read adapter with authenticated log and artifact access, then adds governed
start, stop, manual-approval, and retry actions.

The feature must retain the existing server-owned credential boundary and the
vendor-neutral governed-action lifecycle. A browser or agent may propose an
action, but only an authorized executor may invoke AWS. Every mutation must be
bound to the exact reviewed pipeline, execution, action, revision, and payload.

### User story

As a Control Center operator, I want to inspect bounded execution logs and
download artifacts before I authorize a pipeline mutation, so that I can start,
stop, approve, reject, or retry delivery work with exact evidence, durable
receipts, and no duplicate execution.

## Core requirements

1. Read bounded CloudWatch log events for one validated CodePipeline action.
2. Proxy bounded S3 artifact byte ranges through an authenticated,
   workspace-scoped server endpoint.
3. Never expose AWS credentials, S3 coordinates, signed URLs, raw provider
   errors, or credential-profile material to browser APIs, URLs, persisted
   entities, audit summaries, or application logs.
4. Support governed proposals and execution for:
   - starting a pipeline at explicit immutable source revisions;
   - stopping one exact in-progress execution using stop-and-wait or the
     explicitly higher-risk abandon mode;
   - approving or rejecting one exact pending manual-approval action;
   - retrying an execution as a distinct new execution with the reviewed
     source revisions and a deterministic provider token.
5. Freeze the provider-bound payload at proposal time and verify its digest
   again at preflight, dispatch, and reconciliation.
6. Authorization denial, expiry, stale evidence, changed revision, invalid
   scope, and cancellation before durable dispatch must make zero AWS mutation
   calls.
7. Repeated start or retry submission with the same governed identity must
   resolve to exactly one AWS execution.
8. Ambiguous provider outcomes must reconcile without fabricating terminal
   success or starting a second execution.
9. Preserve the original execution and an attributable `retryOf` relationship
   in the governed-action lineage when retry creates the new execution.

## Technical specifications

- Extend the current modules under
  `packages/control-center/src/server/plugins/codepipeline`.
- Continue using the direct, pinned `@distilled.cloud/aws` dependency and its
  CodePipeline, CloudWatch Logs, S3, and STS operations.
- Decode all provider responses and action payloads with Effect Schema.
- Use `Context.Service`, `Layer.effect`/`Layer.succeed`, `Effect.fn`, typed
  failures, `DateTime`, and scoped runtime acquisition.
- Advertise `action.propose`, `action.execute`, and `action.reconcile` only
  after the production runtime implements them.
- Use AWS `clientRequestToken` for start/retry idempotency. Derive it from the
  immutable action identity using only AWS-accepted characters.
- Treat approval tokens as sensitive provider locators: keep them inside the
  canonical authorized payload and never include them in summaries, operation
  IDs, reconciliation keys, URLs, or logs.
- Keep stop-and-wait as the default. Abandon mode must be explicit and carry a
  critical impact warning because AWS documents out-of-sequence risk.
- Retain the exact checked-in unstable persistence schema; add no migration.

## Acceptance criteria

1. An authenticated owner can page bounded action logs and read bounded
   artifact ranges without learning the CloudWatch or S3 provider locator.
2. Cross-workspace, cross-connection, stale-revision, unknown-action, and
   oversized read requests fail before CloudWatch Logs or S3 is called.
3. Each action kind can be proposed, authorized, preflighted, dispatched, and
   reconciled through the production CodePipeline runtime.
4. Start and retry send the exact reviewed source revisions and deterministic
   `clientRequestToken`.
5. Repeating a retry submission produces one new execution and returns the same
   provider execution identity.
6. Stop targets exactly the reviewed execution and distinguishes stop-and-wait
   from abandon.
7. Approval targets exactly the reviewed stage/action/token and records the
   requested Approved or Rejected result without exposing the token.
8. Denial, expiry, stale evidence, changed payload, failed durable intent, and
   blocked preflight make zero mutation calls.
9. Runtime composition proves one authorized mutation crosses the registry and
   executor projection exactly once and stores the durable result.
10. Focused tests, full repository gates, exact-head CI, CodeRabbit, Codex, and
    zero unresolved review threads pass before merge.

## Out of scope

- Pipeline definition changes, webhook administration, IAM changes, secret
  rotation, arbitrary S3 browsing, arbitrary CloudWatch queries, CodeBuild
  control, deployment-service cancellation, and rollback-stage support.
- Presigned artifact URLs or direct browser access to AWS.
- Unbounded log streams, whole-bucket artifact indexes, archive extraction, or
  content rendering.
- Persistence migrations.

## Success metrics

- Every read and mutation has exact positive and negative provider-call counts.
- A seeded AWS access key, secret key, session token, profile name, bucket/key,
  and approval token are absent from serialized API responses, URLs, audit
  summaries, and logs.
- Log and artifact bounds are enforced before provider calls.
- Duplicate start/retry fixtures return one execution identity from one logical
  provider request token.
- Production runtime composition exercises the real CodePipeline definition,
  registry, executor projection, and durable governance fold.

## Testing requirements

- Schema tests for action payloads, log cursors, artifact selectors/ranges,
  provider responses, and bounded outputs.
- Provider tests for CodePipeline, CloudWatch Logs, and S3 request shapes,
  timeout/auth/authorization/rate-limit/not-found/conflict classification, and
  credential redaction.
- Proposal/preflight tests for target identity, pipeline version, execution
  status, action status, approval token, source revision, and payload digest.
- Zero-call tests for authorization denial, expiry, stale evidence, malformed
  scope, changed revision, oversized reads, and failed durable intent.
- Dispatch/reconciliation tests for confirmed, rejected, retryable,
  ambiguous, pending, succeeded, failed, and cancelled provider states.
- Authenticated HTTP tests for workspace isolation, no-store/nosniff response
  headers, safe attachment disposition, bounded bytes, and absent AWS locators.
- Runtime composition coverage with exactly one provider mutation.
- Run focused tests first, then format, lint (including Effect static checks),
  type-check, build, all tests, browser checks affected by the API, and packed
  package verification.
