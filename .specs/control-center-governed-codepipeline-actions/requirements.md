# Requirements

## FR1.x — Functional requirements

- **FR1.1 — Log selection.** The system SHALL read log events only for an
  action belonging to the configured pipeline and exact execution.
- **FR1.2 — Log bounds.** One request SHALL return at most the configured event
  and UTF-8 byte bounds plus an opaque continuation cursor.
- **FR1.3 — Artifact selection.** The system SHALL resolve one input or output
  artifact from the exact reviewed action and proxy only the requested bounded
  byte range.
- **FR1.4 — Authenticated proxy.** Log and artifact APIs SHALL require a valid
  workspace session and SHALL resolve provider coordinates server-side.
- **FR1.5 — Start proposal.** A start proposal SHALL name the configured
  pipeline and an ordered, unique set of explicit source-action revisions.
- **FR1.6 — Stop proposal.** A stop proposal SHALL bind the execution ID,
  current execution revision, reason, and explicit wait/abandon mode.
- **FR1.7 — Approval proposal.** An approval proposal SHALL bind the execution,
  stage, action, one-time approval token, result, summary, and action revision.
- **FR1.8 — Retry proposal.** A retry proposal SHALL capture the original
  execution, its exact source revisions, and a distinct-execution `retryOf`
  relationship.
- **FR1.9 — Canonical payload.** Proposal SHALL Schema-decode, canonicalize,
  digest, and freeze every provider-bound field.
- **FR1.10 — Final preflight.** Execution SHALL re-read the target immediately
  before dispatch and block when identity, pipeline version, status, source
  revision, approval token, or expected revision changed.
- **FR1.11 — Deterministic execution token.** Start and retry SHALL send one
  deterministic AWS `clientRequestToken` derived from the authorized action.
- **FR1.12 — Receipts.** Confirmed mutations SHALL return safe, attributable
  provider operation IDs and summaries; accepted or ambiguous mutations SHALL
  return a reconciliation locator.
- **FR1.13 — Reconciliation.** Reconciliation SHALL use provider state or the
  same provider-enforced idempotency token and SHALL never create a second
  logical execution.
- **FR1.14 — Zero unintended writes.** Denial, expiry, stale evidence, changed
  payload, invalid scope, failed durable intent, and blocked preflight SHALL
  make zero AWS mutation calls.

## NFR2.x — Non-functional requirements

- **NFR2.1 — Secret safety.** AWS credentials, profile material, approval
  tokens, S3 coordinates, signed URLs, and raw provider causes SHALL not appear
  in client-visible or persisted safe-text surfaces.
- **NFR2.2 — Bounded resources.** Log event count, log bytes, artifact range
  length, provider pages, cursor length, summaries, reasons, variables, and
  source revisions SHALL have Schema-enforced limits.
- **NFR2.3 — Least authority.** Read endpoints SHALL expose no mutation
  capability, and the live executor SHALL remain sealed behind the internal
  authorized executor projection.
- **NFR2.4 — Partial failure.** Provider failures SHALL map to typed,
  provider-scoped errors without affecting unrelated connections.
- **NFR2.5 — Observability safety.** Traces and logs MAY include operation names
  and opaque identifiers but SHALL exclude provider payloads and credentials.
- **NFR2.6 — Thin delivery.** The implementation SHALL reuse existing plugin,
  governance, registry, HTTP, and persistence boundaries.

## TC3.x — Technical constraints

- **TC3.1 — Effect.** New runtime code SHALL follow repository Effect beta
  conventions and use no raw host APIs.
- **TC3.2 — Schema boundary.** Every untrusted AWS response, HTTP input, action
  payload, cursor, and reconstructed reconciliation key SHALL be decoded.
- **TC3.3 — AWS client.** Runtime access SHALL use the pinned public
  `@distilled.cloud/aws` operations and the existing credential chain.
- **TC3.4 — Capability truthfulness.** The descriptor SHALL advertise only
  implemented and runtime-wired capabilities.
- **TC3.5 — Exact schema.** No SQL schema or migration SHALL change.
- **TC3.6 — Safe retry.** Non-idempotent writes SHALL not use generic transport
  retries; start/retry may repeat only with the same provider-enforced token.

## DR4.x — Data requirements

- **DR4.1 — Log cursor.** A log cursor SHALL be opaque, bounded, and valid only
  for the selected action/log stream.
- **DR4.2 — Artifact locator.** Browser inputs SHALL contain execution, action,
  direction, artifact name, expected revision, offset, and length—not bucket,
  key, ARN, credentials, or URL.
- **DR4.3 — Action lineage.** Retry SHALL retain the original execution target
  and the new provider execution ID in the governed action lifecycle.
- **DR4.4 — Provider operation identity.** Provider operation and
  reconciliation IDs SHALL be bounded, parseable, secret-free, and stable.
- **DR4.5 — No persisted provider secrets.** Approval tokens and AWS
  credentials SHALL not enter non-secret persistence columns.

## IR5.x — Integration requirements

- **IR5.1 — CodePipeline.** Start, stop, approval, pipeline state, execution
  reads, and execution listing SHALL use CodePipeline APIs.
- **IR5.2 — CloudWatch Logs.** Log reads SHALL use an exact decoded log group
  and stream derived from the selected action's provider metadata.
- **IR5.3 — S3.** Artifact ranges SHALL use exact selected artifact metadata and
  provider range requests; no presigned URL SHALL be returned.
- **IR5.4 — Governance.** Proposals and execution SHALL use the existing
  vendor-neutral action envelope, authorization policy, execution store, and
  fold.
- **IR5.5 — Registry.** The production first-party registry SHALL build the
  same executable CodePipeline runtime used by tests.
- **IR5.6 — HTTP.** Authenticated application services SHALL authorize the
  workspace before acquiring a scoped plugin connection.

## DEP6.x — Dependencies

- **DEP6.1 — Roadmap dependency.** Issue #200 SHALL remain complete.
- **DEP6.2 — AWS operations.** The existing direct
  `@distilled.cloud/aws@0.29.1` dependency SHALL provide required services.
- **DEP6.3 — Governance foundation.** Existing action schemas, executor map,
  policy evaluator, durable store, and reconciliation flow SHALL remain the
  source of truth.
- **DEP6.4 — No new migration.** Existing entities and governed-action records
  SHALL carry all required lineage.

## SC7.x — Success criteria

- **SC7.1 — Safe evidence.** Authenticated log and artifact fixtures return the
  selected bounded content with no provider locator or credential leakage.
- **SC7.2 — Exact dispatch.** Every supported action dispatches exactly the
  canonical reviewed payload after a ready preflight.
- **SC7.3 — Duplicate retry.** Repeating the same retry action produces exactly
  one distinct AWS execution linked to the original execution.
- **SC7.4 — Zero-call rejection.** Every rejection class asserts zero AWS
  mutation calls.
- **SC7.5 — Runtime proof.** A production composition fixture crosses the live
  registry/executor boundary once and persists the exact result.
- **SC7.6 — Release proof.** Focused and full repository gates, exact-head CI,
  CodeRabbit, Codex, and review-thread gates are clean.
