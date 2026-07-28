# Implementation Plan

## 1. Contract and provider reads

- [x] Add pipeline log/artifact capability schemas and exports.
- [x] Add capability negotiation/codecs and wrapped optional pipeline reader.
- [x] Add CloudWatch Logs and S3 provider operations with typed failure mapping.
- [x] Add decoded bounded log pages and artifact ranges.
- [x] Add focused schema/provider/client tests.

### Validation checkpoint

- [x] Pipeline capability fixtures reject oversized and mismatched inputs before
      provider calls.
- [x] Seeded credentials and provider locators are absent from outputs.

## 2. Authenticated application APIs

- [x] Add CodePipeline log/artifact HTTP schemas and authenticated endpoints.
- [x] Add a workspace-scoped application service over `PluginConnectionMap`.
- [x] Add handlers with private/no-store, attachment, and nosniff policy.
- [x] Add workspace isolation, bounds, and safe-header tests.

### Validation checkpoint

- [x] Cross-workspace requests make zero provider calls.
- [x] Artifact bytes stream without a bucket, key, ARN, or signed URL.

## 3. Governed actions

- [x] Add canonical start, stop, approval, and retry payloads.
- [x] Add actor identity and proposal summaries/impact levels.
- [x] Add final preflight for every action.
- [x] Add deterministic start/retry tokens and exact provider mutation calls.
- [x] Add confirmed/unknown receipts and reconciliation.
- [x] Advertise and register propose/execute/reconcile capabilities.

### Validation checkpoint

- [x] Each rejection class asserts zero mutations.
- [x] Duplicate start/retry resolves to one execution.
- [x] Approval tokens never enter summaries, locators, or receipts.
- [x] Retry lineage retains old and new execution identities.

## 4. Production composition and documentation

- [x] Wire the executable definition into the first-party runtime registry.
- [x] Add an authorized production-runtime composition fixture with exact
      provider-call count and durable result.
- [x] Update roadmap status and package documentation.
- [x] Add a patch changeset for `@knpkv/control-center`.

### Validation checkpoint

- [x] Production registry and executor projection cross once.
- [x] Exact unstable SQL schema remains unchanged.

## 5. Validation and review

- [x] Run focused tests after each layer.
- [x] Run Prettier, Effect static checks, ESLint, and TypeScript.
- [x] Run package build/tests, full repository gates, and packed-package checks.
- [x] Run independent subagent specification and standards reviews.
- [x] Implement every confirmed finding and its durable prevention guardrail.
- [x] Open the PR only with no remaining local findings.
- [ ] Clear exact-head CI, CodeRabbit, Codex, and unresolved-thread gates.

## Risk mitigation

- AWS start ambiguity is contained by one deterministic client request token.
- Approval races are contained by the provider's one-time approval token.
- Stop ambiguity reconciles from the exact execution status.
- Artifact and log locators remain server-only and are revalidated from the
  selected action before each read.
- If `@distilled.cloud/aws` response shapes differ from documented AWS shapes,
  repository-owned Schema fixtures fail before runtime wiring.

## Success criteria validation

- [x] SC7.1 safe evidence.
- [x] SC7.2 exact dispatch.
- [x] SC7.3 duplicate retry.
- [x] SC7.4 zero-call rejection.
- [x] SC7.5 runtime proof.
- [ ] SC7.6 release proof.
