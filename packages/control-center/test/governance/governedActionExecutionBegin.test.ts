import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"

import { GovernedActionPolicyEvaluationV1 } from "../../src/domain/governedAction/index.js"
import { EntityId, GovernedActionId } from "../../src/domain/identifiers.js"
import { PluginActionDispatchResultV1, ReadyPluginActionPreflightV1 } from "../../src/domain/plugins/actions.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { makeGovernedActionExecutionBegin } from "../../src/server/governance/internal/execution-store/begin.js"
import { makeGovernedActionExecutionInspect } from "../../src/server/governance/internal/execution-store/inspect.js"
import { makeGovernedActionExecutionRecordDispatch } from "../../src/server/governance/internal/execution-store/record-dispatch.js"
import type { GovernedActionBeginResult } from "../../src/server/governance/internal/GovernedActionExecutionStore.js"
import { GovernedActionPolicyEvaluator } from "../../src/server/governance/internal/GovernedActionPolicyEvaluator.js"
import { Database } from "../../src/server/persistence/Database.js"
import { GovernedActionRepository } from "../../src/server/persistence/repositories/governedActionRepository.js"
import { CurrentPluginRuntimeAuthority } from "../../src/server/plugins/internal/PluginRuntimeAuthority.js"
import { seedGovernedAction, seedGovernedActionCurrentInputs } from "./fixtures/authorizedGovernedAction.js"
import {
  ACTION,
  currentRuntime,
  NOW,
  rotatedRuntime,
  runtimeAuthorityLayerFor,
  runtimeWithoutReconciliation,
  seedCurrentInputs,
  withBegin,
  WORKSPACE
} from "./fixtures/governedActionExecution.js"

const retryFixture = (input: {
  readonly actionId: string
  readonly authorizationAuditId: string
  readonly authorizationId: string
  readonly authorizationTransitionId: string
  readonly entityId: string
  readonly executionId: string
  readonly idempotencyKey: string
  readonly proposalAuditId: string
  readonly proposalTransitionId: string
}) => ({
  actionId: Schema.decodeUnknownSync(GovernedActionId)(input.actionId),
  entityId: Schema.decodeUnknownSync(EntityId)(input.entityId),
  executionId: input.executionId,
  identity: {
    actionId: input.actionId,
    authorizationAuditId: input.authorizationAuditId,
    authorizationId: input.authorizationId,
    authorizationTransitionId: input.authorizationTransitionId,
    idempotencyKey: input.idempotencyKey,
    proposalAuditId: input.proposalAuditId,
    proposalTransitionId: input.proposalTransitionId
  }
})
const siblingRetry = retryFixture({
  actionId: "01890f6f-6d6a-7cc0-98d2-440000000012",
  authorizationAuditId: "01890f6f-6d6a-7cc0-98d2-440000000013",
  authorizationId: "01890f6f-6d6a-7cc0-98d2-440000000014",
  authorizationTransitionId: "01890f6f-6d6a-7cc0-98d2-440000000015",
  entityId: "01890f6f-6d6a-7cc0-98d2-440000000018",
  executionId: "execution-retry-2",
  idempotencyKey: "governed-action:codepipeline:execution-failed-1:retry:2",
  proposalAuditId: "01890f6f-6d6a-7cc0-98d2-440000000016",
  proposalTransitionId: "01890f6f-6d6a-7cc0-98d2-440000000017"
})
const childRetry = retryFixture({
  actionId: "01890f6f-6d6a-7cc0-98d2-440000000019",
  authorizationAuditId: "01890f6f-6d6a-7cc0-98d2-44000000001a",
  authorizationId: "01890f6f-6d6a-7cc0-98d2-44000000001b",
  authorizationTransitionId: "01890f6f-6d6a-7cc0-98d2-44000000001c",
  entityId: "01890f6f-6d6a-7cc0-98d2-44000000001f",
  executionId: "execution-retry-3",
  idempotencyKey: "governed-action:codepipeline:execution-retry-1:retry:3",
  proposalAuditId: "01890f6f-6d6a-7cc0-98d2-44000000001d",
  proposalTransitionId: "01890f6f-6d6a-7cc0-98d2-44000000001e"
})
const deniedBranchRetry = retryFixture({
  actionId: "01890f6f-6d6a-7cc0-98d2-440000000020",
  authorizationAuditId: "01890f6f-6d6a-7cc0-98d2-440000000021",
  authorizationId: "01890f6f-6d6a-7cc0-98d2-440000000022",
  authorizationTransitionId: "01890f6f-6d6a-7cc0-98d2-440000000023",
  entityId: "01890f6f-6d6a-7cc0-98d2-440000000026",
  executionId: "execution-retry-denied",
  idempotencyKey: "governed-action:codepipeline:execution-retry-2:retry:4",
  proposalAuditId: "01890f6f-6d6a-7cc0-98d2-440000000024",
  proposalTransitionId: "01890f6f-6d6a-7cc0-98d2-440000000025"
})
const unrelatedRetry = retryFixture({
  actionId: "01890f6f-6d6a-7cc0-98d2-440000000027",
  authorizationAuditId: "01890f6f-6d6a-7cc0-98d2-440000000028",
  authorizationId: "01890f6f-6d6a-7cc0-98d2-440000000029",
  authorizationTransitionId: "01890f6f-6d6a-7cc0-98d2-44000000002a",
  entityId: "01890f6f-6d6a-7cc0-98d2-44000000002d",
  executionId: "unrelated-failed-execution",
  idempotencyKey: "governed-action:codepipeline:unrelated-failed-execution:retry:1",
  proposalAuditId: "01890f6f-6d6a-7cc0-98d2-44000000002b",
  proposalTransitionId: "01890f6f-6d6a-7cc0-98d2-44000000002c"
})
const FIRST_RETRY_EXECUTION_ID = "execution-retry-1"
const FIRST_RETRY_EXECUTION_ENTITY = Schema.decodeUnknownSync(EntityId)(
  "01890f6f-6d6a-7cc0-98d2-44000000002e"
)
const encodedCurrentRuntime = Schema.encodeSync(CurrentPluginRuntimeAuthority)(currentRuntime)
const codePipelineRuntime = Schema.decodeUnknownSync(CurrentPluginRuntimeAuthority)({
  ...encodedCurrentRuntime,
  expected: {
    ...encodedCurrentRuntime.expected,
    providerId: "codepipeline"
  },
  negotiated: {
    ...encodedCurrentRuntime.negotiated,
    descriptor: {
      ...encodedCurrentRuntime.negotiated.descriptor,
      pluginId: "dev.knpkv.aws-codepipeline",
      adapterVersion: { major: 0, minor: 2, patch: 0 },
      displayName: "AWS CodePipeline"
    }
  }
})
const retryCeilingPolicyLayer = Layer.succeed(GovernedActionPolicyEvaluator, {
  evaluate: (input) =>
    Effect.succeed(GovernedActionPolicyEvaluationV1.make({
      schemaVersion: 1,
      actionId: input.envelope.actionId,
      workspaceId: input.envelope.workspaceId,
      policy: input.envelope.policy,
      payloadDigest: input.envelope.proposal.payloadDigest,
      evidenceSetDigest: input.envelope.evidenceSetDigest,
      expectedRevision: input.envelope.proposal.request.expectedRevision,
      decision: input.envelope.proposal.request.actionKind === "pipeline.retry" &&
          input.priorTargetAttempts >= 3
        ? "denied"
        : "allowed",
      evaluatedAt: input.evaluatedAt
    }))
})

const seedRetryExecution = Effect.fn("GovernedActionExecutionBeginTest.seedRetryExecution")(function*(
  entityId: EntityId,
  executionId: string,
  observedAtText: string
) {
  const { sql } = yield* Database
  yield* sql`INSERT INTO entities (
    workspace_id, entity_id, plugin_connection_id, provider_id,
    vendor_immutable_id, entity_type, current_revision, created_at, updated_at
  ) VALUES (
    ${WORKSPACE}, ${entityId}, ${codePipelineRuntime.scope.pluginConnectionId},
    'codepipeline', ${executionId}, 'pipeline-execution', 1,
    ${observedAtText}, ${observedAtText}
  )`
  yield* sql`INSERT INTO entity_revisions (
    workspace_id, entity_id, revision, source_revision, normalization_schema_version,
    source_url, first_observed_at, last_observed_at, synchronized_at, created_at
  ) VALUES (
    ${WORKSPACE}, ${entityId}, 1,
    '7:Failed:2026-07-15T09:50:00.000Z', 1,
    ${`https://example.test/pipelines/release/executions/${executionId}`},
    ${observedAtText}, ${observedAtText}, ${observedAtText}, ${observedAtText}
  )`
  yield* sql`INSERT INTO entity_projection_revisions (
    workspace_id, entity_id, projection_revision, source_entity_revision,
    supersedes_projection_revision, projection_schema_version, entity_state,
    display_key, title, extension_json, extension_digest, recorded_at
  )
  SELECT workspace_id, ${entityId}, projection_revision, source_entity_revision,
    supersedes_projection_revision, projection_schema_version, entity_state,
    ${executionId}, ${`release · ${executionId}`}, extension_json, extension_digest,
    ${observedAtText}
  FROM entity_projection_revisions
  WHERE workspace_id = ${WORKSPACE}
    AND entity_id = (
      SELECT target_entity_id
      FROM governed_actions
      WHERE workspace_id = ${WORKSPACE}
        AND action_id = ${ACTION}
    )`
})

describe("governed action execution begin", () => {
  it.effect("atomically consumes preparation and returns exactly one durable permit", () =>
    withBegin(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
      yield* seedGovernedAction()
      yield* seedCurrentInputs()
      const inspect = yield* makeGovernedActionExecutionInspect
      const prepared = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
      assert.strictEqual(prepared._tag, "dispatch")
      if (prepared._tag !== "dispatch") return

      const begin = yield* makeGovernedActionExecutionBegin
      const preflight = Schema.decodeUnknownSync(ReadyPluginActionPreflightV1)({
        _tag: "ready",
        checkedRevision: "1",
        checkedAt: "2026-07-15T10:02:00.000Z"
      })
      const result = yield* begin.begin({
        preparationToken: prepared.preparationToken,
        preflight,
        runtimeAuthorityToken: currentRuntime.runtimeAuthorityToken,
        scope: prepared.scope
      })

      assert.strictEqual(result._tag, "permitted")
      if (result._tag !== "permitted") return
      assert.isTrue(DateTime.Order(result.dispatchDeadline, result.leaseExpiresAt) < 0)
      const actions = yield* GovernedActionRepository
      assert.strictEqual(
        (yield* actions.read({ workspaceId: WORKSPACE, actionId: ACTION })).head.state,
        "started"
      )
      const { sql } = yield* Database
      const counts = yield* sql<{
        readonly attempts: number
        readonly leases: number
        readonly preparations: number
      }>`SELECT
        (SELECT COUNT(*) FROM governed_action_attempts) AS attempts,
        (SELECT COUNT(*) FROM governed_action_execution_leases) AS leases,
        (SELECT COUNT(*) FROM governed_action_execution_preparations) AS preparations`
      assert.deepStrictEqual(counts[0], { attempts: 1, leases: 1, preparations: 0 })

      const replay = yield* begin.begin({
        preparationToken: prepared.preparationToken,
        preflight,
        runtimeAuthorityToken: currentRuntime.runtimeAuthorityToken,
        scope: prepared.scope
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(replay))
      if (Result.isFailure(replay)) {
        assert.strictEqual(replay.failure.reason, "not-found")
      }
      const unchanged = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
        FROM governed_action_attempts`
      assert.strictEqual(unchanged[0]?.count, 1)
    })))

  it.effect("serializes concurrent begins for the same preparation", () =>
    withBegin(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
      yield* seedGovernedAction()
      yield* seedCurrentInputs()
      const inspect = yield* makeGovernedActionExecutionInspect
      const prepared = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
      assert.strictEqual(prepared._tag, "dispatch")
      if (prepared._tag !== "dispatch") return

      const begin = yield* makeGovernedActionExecutionBegin
      const input = {
        preparationToken: prepared.preparationToken,
        preflight: Schema.decodeUnknownSync(ReadyPluginActionPreflightV1)({
          _tag: "ready",
          checkedRevision: "1",
          checkedAt: "2026-07-15T10:02:00.000Z"
        }),
        runtimeAuthorityToken: currentRuntime.runtimeAuthorityToken,
        scope: prepared.scope
      }
      const results = yield* Effect.all([
        begin.begin(input).pipe(Effect.result),
        begin.begin(input).pipe(Effect.result)
      ], { concurrency: "unbounded" })

      const permitted = results.filter(Result.isSuccess)
      const rejected = results.filter(Result.isFailure)
      assert.lengthOf(permitted, 1)
      assert.lengthOf(rejected, 1)
      assert.strictEqual(permitted[0]?.success._tag, "permitted")
      assert.include(["conflict", "not-found"], rejected[0]?.failure.reason)

      const { sql } = yield* Database
      const counts = yield* sql<{
        readonly attempts: number
        readonly leases: number
        readonly preparations: number
        readonly startTransitions: number
      }>`SELECT
        (SELECT COUNT(*) FROM governed_action_attempts) AS attempts,
        (SELECT COUNT(*) FROM governed_action_execution_leases) AS leases,
        (SELECT COUNT(*) FROM governed_action_execution_preparations) AS preparations,
        (SELECT COUNT(*) FROM governed_action_transitions WHERE command_tag = 'start') AS startTransitions`
      assert.deepStrictEqual(counts[0], {
        attempts: 1,
        leases: 1,
        preparations: 0,
        startTransitions: 1
      })
    })))

  it.effect("counts the complete branched retry component before issuing a provider permit", () =>
    withBegin(
      Effect.gen(function*() {
        yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
        yield* seedGovernedAction({ variant: "codepipeline" })
        yield* seedGovernedActionCurrentInputs("codepipeline")
        const inspect = yield* makeGovernedActionExecutionInspect
        const begin = yield* makeGovernedActionExecutionBegin
        const dispatch = yield* makeGovernedActionExecutionRecordDispatch
        const beginPrepared = Effect.fn("GovernedActionExecutionBeginTest.beginPrepared")(function*(
          actionId: GovernedActionId,
          checkedAt: string
        ) {
          const prepared = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId })
          assert.strictEqual(prepared._tag, "dispatch")
          if (prepared._tag !== "dispatch") return yield* Effect.die("expected retry dispatch")
          return yield* begin.begin({
            preparationToken: prepared.preparationToken,
            preflight: Schema.decodeUnknownSync(ReadyPluginActionPreflightV1)({
              _tag: "ready",
              checkedRevision: "7:Failed:2026-07-15T09:50:00.000Z",
              checkedAt
            }),
            runtimeAuthorityToken: codePipelineRuntime.runtimeAuthorityToken,
            scope: prepared.scope
          })
        })
        const accept = Effect.fn("GovernedActionExecutionBeginTest.accept")(function*(
          result: GovernedActionBeginResult,
          executionId: string,
          observedAt: string,
          receivedAt: string
        ) {
          assert.strictEqual(result._tag, "permitted")
          if (result._tag !== "permitted") return yield* Effect.die("expected retry permit")
          const receivedTimestamp = Schema.decodeUnknownSync(UtcTimestamp)(receivedAt)
          yield* TestClock.setTime(DateTime.toEpochMillis(receivedTimestamp))
          yield* dispatch.recordDispatch({
            permitToken: result.permitToken,
            result: Schema.decodeUnknownSync(PluginActionDispatchResultV1)({
              _tag: "confirmed",
              receipt: {
                status: "accepted",
                providerOperationId: executionId,
                reconciliationKey: `reconcile-${executionId}`,
                safeSummary: `Provider accepted ${executionId}`,
                observedAt
              }
            }),
            observedAt: receivedTimestamp
          })
        })

        const first = yield* beginPrepared(ACTION, "2026-07-15T10:02:00.000Z")
        yield* accept(
          first,
          FIRST_RETRY_EXECUTION_ID,
          "2026-07-15T10:02:01.000Z",
          "2026-07-15T10:02:02.000Z"
        )
        yield* seedRetryExecution(
          FIRST_RETRY_EXECUTION_ENTITY,
          FIRST_RETRY_EXECUTION_ID,
          "2026-07-15T10:02:01.000Z"
        )
        yield* seedRetryExecution(
          siblingRetry.entityId,
          siblingRetry.executionId,
          "2026-07-15T10:02:03.000Z"
        )
        yield* seedGovernedAction({
          identity: siblingRetry.identity,
          retryOf: "execution-failed-1",
          seedAuthorityRoots: false,
          variant: "codepipeline"
        })
        const sibling = yield* beginPrepared(
          siblingRetry.actionId,
          "2026-07-15T10:02:02.000Z"
        )
        yield* accept(
          sibling,
          siblingRetry.executionId,
          "2026-07-15T10:02:03.000Z",
          "2026-07-15T10:02:04.000Z"
        )

        yield* seedRetryExecution(
          childRetry.entityId,
          childRetry.executionId,
          "2026-07-15T10:02:05.000Z"
        )
        yield* seedGovernedAction({
          identity: childRetry.identity,
          retryOf: FIRST_RETRY_EXECUTION_ID,
          seedAuthorityRoots: false,
          targetEntityId: FIRST_RETRY_EXECUTION_ENTITY,
          targetVendorImmutableId: FIRST_RETRY_EXECUTION_ID,
          variant: "codepipeline"
        })
        const child = yield* beginPrepared(
          childRetry.actionId,
          "2026-07-15T10:02:04.000Z"
        )
        yield* accept(
          child,
          childRetry.executionId,
          "2026-07-15T10:02:05.000Z",
          "2026-07-15T10:02:06.000Z"
        )

        yield* seedGovernedAction({
          identity: deniedBranchRetry.identity,
          retryOf: siblingRetry.executionId,
          seedAuthorityRoots: false,
          targetEntityId: siblingRetry.entityId,
          targetVendorImmutableId: siblingRetry.executionId,
          variant: "codepipeline"
        })
        const denied = yield* beginPrepared(
          deniedBranchRetry.actionId,
          "2026-07-15T10:02:06.000Z"
        )
        assert.deepStrictEqual(denied, { _tag: "inactive", state: "denied" })
        const { sql } = yield* Database
        const rows = yield* sql<{
          readonly attempts: number
          readonly deniedState: string
          readonly permits: number
        }>`SELECT
          (SELECT COUNT(*) FROM governed_action_attempts) AS attempts,
          (SELECT state FROM governed_actions
            WHERE action_id = ${deniedBranchRetry.actionId}) AS deniedState,
          (SELECT COUNT(*) FROM governed_action_execution_leases) AS permits`
        assert.deepStrictEqual(rows[0], {
          attempts: 3,
          deniedState: "denied",
          permits: 3
        })

        yield* seedRetryExecution(
          unrelatedRetry.entityId,
          unrelatedRetry.executionId,
          "2026-07-15T10:02:07.000Z"
        )
        yield* seedGovernedAction({
          identity: unrelatedRetry.identity,
          retryOf: unrelatedRetry.executionId,
          seedAuthorityRoots: false,
          targetEntityId: unrelatedRetry.entityId,
          targetVendorImmutableId: unrelatedRetry.executionId,
          variant: "codepipeline"
        })
        yield* TestClock.setTime(DateTime.toEpochMillis(
          Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:02:07.000Z")
        ))
        const unrelated = yield* beginPrepared(
          unrelatedRetry.actionId,
          "2026-07-15T10:02:07.000Z"
        )
        assert.strictEqual(unrelated._tag, "permitted")
        const independent = yield* sql<{
          readonly attempts: number
          readonly permits: number
        }>`SELECT
          (SELECT COUNT(*) FROM governed_action_attempts) AS attempts,
          (SELECT COUNT(*) FROM governed_action_execution_leases) AS permits`
        assert.deepStrictEqual(independent[0], { attempts: 4, permits: 4 })
      }),
      runtimeAuthorityLayerFor(codePipelineRuntime),
      retryCeilingPolicyLayer
    ))

  it.effect("rolls back the start transition when the execution lease cannot be written", () =>
    withBegin(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
      yield* seedGovernedAction()
      yield* seedCurrentInputs()
      const inspect = yield* makeGovernedActionExecutionInspect
      const prepared = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
      assert.strictEqual(prepared._tag, "dispatch")
      if (prepared._tag !== "dispatch") return

      const { sql } = yield* Database
      yield* sql`CREATE TRIGGER governed_action_test_fail_execution_lease
        BEFORE INSERT ON governed_action_execution_leases
        BEGIN
          SELECT RAISE(ABORT, 'injected execution lease failure');
        END`
      const begin = yield* makeGovernedActionExecutionBegin
      const input = {
        preparationToken: prepared.preparationToken,
        preflight: Schema.decodeUnknownSync(ReadyPluginActionPreflightV1)({
          _tag: "ready",
          checkedRevision: "1",
          checkedAt: "2026-07-15T10:02:00.000Z"
        }),
        runtimeAuthorityToken: currentRuntime.runtimeAuthorityToken,
        scope: prepared.scope
      }
      const failed = yield* begin.begin(input).pipe(Effect.result)

      assert.isTrue(Result.isFailure(failed))
      if (Result.isFailure(failed)) assert.strictEqual(failed.failure.reason, "persistence-unavailable")
      const rolledBack = yield* sql<{
        readonly attempts: number
        readonly leases: number
        readonly preparations: number
        readonly startTransitions: number
        readonly state: string
      }>`SELECT
        (SELECT COUNT(*) FROM governed_action_attempts) AS attempts,
        (SELECT COUNT(*) FROM governed_action_execution_leases) AS leases,
        (SELECT COUNT(*) FROM governed_action_execution_preparations) AS preparations,
        (SELECT COUNT(*) FROM governed_action_transitions WHERE command_tag = 'start') AS startTransitions,
        (SELECT state FROM governed_actions WHERE action_id = ${ACTION}) AS state`
      assert.deepStrictEqual(rolledBack[0], {
        attempts: 0,
        leases: 0,
        preparations: 1,
        startTransitions: 0,
        state: "authorized"
      })

      yield* sql`DROP TRIGGER governed_action_test_fail_execution_lease`
      const retry = yield* begin.begin(input)
      assert.strictEqual(retry._tag, "permitted")
    })))

  it.effect("rejects a rotated runtime generation without consuming the preparation", () =>
    withBegin(
      Effect.gen(function*() {
        yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
        yield* seedGovernedAction()
        yield* seedCurrentInputs()
        const inspect = yield* makeGovernedActionExecutionInspect
        const prepared = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
        assert.strictEqual(prepared._tag, "dispatch")
        if (prepared._tag !== "dispatch") return

        const begin = yield* makeGovernedActionExecutionBegin
        const baseInput = {
          preparationToken: prepared.preparationToken,
          preflight: Schema.decodeUnknownSync(ReadyPluginActionPreflightV1)({
            _tag: "ready",
            checkedRevision: "1",
            checkedAt: "2026-07-15T10:02:00.000Z"
          }),
          scope: prepared.scope
        }
        const staleRuntime = yield* begin.begin({
          ...baseInput,
          runtimeAuthorityToken: currentRuntime.runtimeAuthorityToken
        }).pipe(Effect.result)
        const changedEnvelopeAuthority = yield* begin.begin({
          ...baseInput,
          runtimeAuthorityToken: rotatedRuntime.runtimeAuthorityToken
        }).pipe(Effect.result)

        assert.isTrue(Result.isFailure(staleRuntime))
        assert.isTrue(Result.isFailure(changedEnvelopeAuthority))
        if (Result.isFailure(staleRuntime)) {
          assert.strictEqual(staleRuntime.failure.reason, "authority-changed")
        }
        if (Result.isFailure(changedEnvelopeAuthority)) {
          assert.strictEqual(changedEnvelopeAuthority.failure.reason, "authority-changed")
        }
        const { sql } = yield* Database
        const rows = yield* sql<{
          readonly attempts: number
          readonly leases: number
          readonly preparations: number
          readonly state: string
        }>`SELECT
        (SELECT COUNT(*) FROM governed_action_attempts) AS attempts,
        (SELECT COUNT(*) FROM governed_action_execution_leases) AS leases,
        (SELECT COUNT(*) FROM governed_action_execution_preparations) AS preparations,
        (SELECT state FROM governed_actions WHERE action_id = ${ACTION}) AS state`
        assert.deepStrictEqual(rows[0], {
          attempts: 0,
          leases: 0,
          preparations: 1,
          state: "authorized"
        })
      }),
      runtimeAuthorityLayerFor(rotatedRuntime)
    ))

  it.effect("consumes a preparation exactly at its expiry boundary", () =>
    withBegin(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
      yield* seedGovernedAction()
      yield* seedCurrentInputs()
      const inspect = yield* makeGovernedActionExecutionInspect
      const prepared = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
      assert.strictEqual(prepared._tag, "dispatch")
      if (prepared._tag !== "dispatch") return

      yield* TestClock.adjust("30 seconds")
      const begin = yield* makeGovernedActionExecutionBegin
      const result = yield* begin.begin({
        preparationToken: prepared.preparationToken,
        preflight: Schema.decodeUnknownSync(ReadyPluginActionPreflightV1)({
          _tag: "ready",
          checkedRevision: "1",
          checkedAt: "2026-07-15T10:02:00.000Z"
        }),
        runtimeAuthorityToken: currentRuntime.runtimeAuthorityToken,
        scope: prepared.scope
      })

      assert.deepStrictEqual(result, { _tag: "inactive", state: "authorized" })
      const { sql } = yield* Database
      const counts = yield* sql<{
        readonly attempts: number
        readonly preparations: number
        readonly startTransitions: number
      }>`SELECT
        (SELECT COUNT(*) FROM governed_action_attempts) AS attempts,
        (SELECT COUNT(*) FROM governed_action_execution_preparations) AS preparations,
        (SELECT COUNT(*) FROM governed_action_transitions WHERE command_tag = 'start') AS startTransitions`
      assert.deepStrictEqual(counts[0], { attempts: 0, preparations: 0, startTransitions: 0 })
    })))

  it.effect("rejects a session exactly at its idle expiry without consuming the preparation", () =>
    withBegin(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
      yield* seedGovernedAction()
      yield* seedCurrentInputs()
      const inspect = yield* makeGovernedActionExecutionInspect
      const prepared = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
      assert.strictEqual(prepared._tag, "dispatch")
      if (prepared._tag !== "dispatch") return
      const { sql } = yield* Database
      yield* sql`UPDATE sessions SET idle_expires_at = ${DateTime.formatIso(NOW)}
        WHERE workspace_id = ${WORKSPACE}`

      const begin = yield* makeGovernedActionExecutionBegin
      const result = yield* begin.begin({
        preparationToken: prepared.preparationToken,
        preflight: Schema.decodeUnknownSync(ReadyPluginActionPreflightV1)({
          _tag: "ready",
          checkedRevision: "1",
          checkedAt: "2026-07-15T10:02:00.000Z"
        }),
        runtimeAuthorityToken: currentRuntime.runtimeAuthorityToken,
        scope: prepared.scope
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "authority-changed")
      const counts = yield* sql<{
        readonly attempts: number
        readonly preparations: number
      }>`SELECT
        (SELECT COUNT(*) FROM governed_action_attempts) AS attempts,
        (SELECT COUNT(*) FROM governed_action_execution_preparations) AS preparations`
      assert.deepStrictEqual(counts[0], { attempts: 0, preparations: 1 })
    })))

  it.effect("rejects stale preflight evidence without consuming the preparation", () =>
    withBegin(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
      yield* seedGovernedAction()
      yield* seedCurrentInputs()
      const inspect = yield* makeGovernedActionExecutionInspect
      const prepared = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
      assert.strictEqual(prepared._tag, "dispatch")
      if (prepared._tag !== "dispatch") return

      const begin = yield* makeGovernedActionExecutionBegin
      const result = yield* begin.begin({
        preparationToken: prepared.preparationToken,
        preflight: Schema.decodeUnknownSync(ReadyPluginActionPreflightV1)({
          _tag: "ready",
          checkedRevision: "1",
          checkedAt: "2026-07-15T10:01:59.999Z"
        }),
        runtimeAuthorityToken: currentRuntime.runtimeAuthorityToken,
        scope: prepared.scope
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "conflict")
      const { sql } = yield* Database
      const counts = yield* sql<{
        readonly attempts: number
        readonly preparations: number
      }>`SELECT
        (SELECT COUNT(*) FROM governed_action_attempts) AS attempts,
        (SELECT COUNT(*) FROM governed_action_execution_preparations) AS preparations`
      assert.deepStrictEqual(counts[0], { attempts: 0, preparations: 1 })
    })))

  it.effect("rejects a runtime without reconciliation capability and preserves retry state", () =>
    withBegin(
      Effect.gen(function*() {
        yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
        yield* seedGovernedAction()
        yield* seedCurrentInputs()
        const inspect = yield* makeGovernedActionExecutionInspect
        const prepared = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
        assert.strictEqual(prepared._tag, "dispatch")
        if (prepared._tag !== "dispatch") return

        const begin = yield* makeGovernedActionExecutionBegin
        const result = yield* begin.begin({
          preparationToken: prepared.preparationToken,
          preflight: Schema.decodeUnknownSync(ReadyPluginActionPreflightV1)({
            _tag: "ready",
            checkedRevision: "1",
            checkedAt: "2026-07-15T10:02:00.000Z"
          }),
          runtimeAuthorityToken: runtimeWithoutReconciliation.runtimeAuthorityToken,
          scope: prepared.scope
        }).pipe(Effect.result)

        assert.isTrue(Result.isFailure(result))
        if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "conflict")
        const { sql } = yield* Database
        const counts = yield* sql<{
          readonly attempts: number
          readonly preparations: number
        }>`SELECT
        (SELECT COUNT(*) FROM governed_action_attempts) AS attempts,
        (SELECT COUNT(*) FROM governed_action_execution_preparations) AS preparations`
        assert.deepStrictEqual(counts[0], { attempts: 0, preparations: 1 })
      }),
      runtimeAuthorityLayerFor(runtimeWithoutReconciliation)
    ))

  it.effect("expires authority and consumes its preparation in the same transaction", () =>
    withBegin(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
      yield* seedGovernedAction({ authorizationExpiresAt: "2026-07-15T10:02:05.000Z" })
      yield* seedCurrentInputs()
      const inspect = yield* makeGovernedActionExecutionInspect
      const prepared = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
      assert.strictEqual(prepared._tag, "dispatch")
      if (prepared._tag !== "dispatch") return
      yield* TestClock.setTime(DateTime.toEpochMillis(
        Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:02:05.000Z")
      ))
      const begin = yield* makeGovernedActionExecutionBegin
      const result = yield* begin.begin({
        preparationToken: prepared.preparationToken,
        preflight: Schema.decodeUnknownSync(ReadyPluginActionPreflightV1)({
          _tag: "ready",
          checkedRevision: "1",
          checkedAt: "2026-07-15T10:02:04.000Z"
        }),
        runtimeAuthorityToken: currentRuntime.runtimeAuthorityToken,
        scope: prepared.scope
      })

      assert.deepStrictEqual(result, { _tag: "inactive", state: "expired" })
      const { sql } = yield* Database
      const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
        FROM governed_action_execution_preparations`
      assert.strictEqual(rows[0]?.count, 0)
    })))

  it.effect("persists current policy denial without retaining a preparation", () =>
    withBegin(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
      yield* seedGovernedAction()
      yield* seedCurrentInputs()
      const inspect = yield* makeGovernedActionExecutionInspect
      const prepared = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
      assert.strictEqual(prepared._tag, "dispatch")
      if (prepared._tag !== "dispatch") return
      const { sql } = yield* Database
      yield* sql`UPDATE sessions SET permission = 'release-owner'
        WHERE workspace_id = ${WORKSPACE}`
      const begin = yield* makeGovernedActionExecutionBegin
      const result = yield* begin.begin({
        preparationToken: prepared.preparationToken,
        preflight: Schema.decodeUnknownSync(ReadyPluginActionPreflightV1)({
          _tag: "ready",
          checkedRevision: "1",
          checkedAt: "2026-07-15T10:02:00.000Z"
        }),
        runtimeAuthorityToken: currentRuntime.runtimeAuthorityToken,
        scope: prepared.scope
      })

      assert.deepStrictEqual(result, { _tag: "inactive", state: "denied" })
      const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
        FROM governed_action_execution_preparations`
      assert.strictEqual(rows[0]?.count, 0)
    })))

  it.effect("classifies revoked live authority and preserves retry state on rollback", () =>
    withBegin(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(NOW))
      yield* seedGovernedAction()
      yield* seedCurrentInputs()
      const inspect = yield* makeGovernedActionExecutionInspect
      const prepared = yield* inspect.inspect({ workspaceId: WORKSPACE, actionId: ACTION })
      assert.strictEqual(prepared._tag, "dispatch")
      if (prepared._tag !== "dispatch") return
      const { sql } = yield* Database
      yield* sql`UPDATE sessions SET revoked_at = '2026-07-15T10:02:00.000Z'
        WHERE workspace_id = ${WORKSPACE}`
      const begin = yield* makeGovernedActionExecutionBegin
      const result = yield* begin.begin({
        preparationToken: prepared.preparationToken,
        preflight: Schema.decodeUnknownSync(ReadyPluginActionPreflightV1)({
          _tag: "ready",
          checkedRevision: "1",
          checkedAt: "2026-07-15T10:02:00.000Z"
        }),
        runtimeAuthorityToken: currentRuntime.runtimeAuthorityToken,
        scope: prepared.scope
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure.reason, "authority-changed")
      const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count
        FROM governed_action_execution_preparations`
      assert.strictEqual(rows[0]?.count, 1)
    })))
})
