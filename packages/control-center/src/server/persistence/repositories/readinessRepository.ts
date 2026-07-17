import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import type { Success } from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import type { WorkspaceId } from "../../../domain/identifiers.js"
import { Database } from "../Database.js"
import { PersistedRecordError, type PersistenceOperationError, type QuarantineWriteError } from "../errors.js"
import { mapPersistenceOperation } from "./internal.js"
import { makePersistedRowQuarantine } from "./persistedRowQuarantine.js"
import { QuarantineRepository } from "./quarantineRepository.js"
import { makeReadinessAssessments } from "./readiness/assessments.js"
import {
  ClaimReadinessInvalidationRequest,
  CommitEnvironmentReadinessAssessmentRequest,
  CommitReleaseReadinessAssessmentRequest,
  type CurrentEnvironmentReadinessAssessmentRecord,
  type CurrentReleaseReadinessAssessmentRecord,
  EnqueueAffectedReadinessRequest,
  EnqueueDueReadinessEvaluationsRequest,
  EnqueueReadinessInvalidationRequest,
  type EnvironmentReadinessAssessmentRecord,
  ReadCurrentReadinessAssessmentRequest,
  type ReadCurrentReadinessAssessmentResult,
  ReadCurrentReleaseReadinessAssessmentsRequest,
  type ReadCurrentReleaseReadinessAssessmentsResult,
  ReadinessInputError,
  ReadReadinessHistoryRequest,
  type ReadReadinessHistoryResult,
  RegisterReadinessRuleRequest,
  type ReleaseReadinessAssessmentRecord
} from "./readiness/contract.js"
import type { MalformedReadinessRecord } from "./readiness/quarantine.js"
import { readinessQuarantineDiagnostic } from "./readiness/quarantine.js"
import { makeReadinessQueue } from "./readiness/queue.js"
import { makeReadinessRules } from "./readiness/rules.js"

export * from "./readiness/contract.js"

const makeReadinessRepository = Effect.gen(function*() {
  const database = yield* Database
  const cryptoService = yield* Crypto.Crypto
  const quarantine = yield* QuarantineRepository
  const quarantineRow = makePersistedRowQuarantine(cryptoService, quarantine)
  const assessments = yield* makeReadinessAssessments
  const queue = yield* makeReadinessQueue
  const rules = yield* makeReadinessRules

  const decodeInput = <Value, Encoded, Requirements>(
    operation: ReadinessInputError["operation"],
    schema: Schema.Codec<Value, Encoded, Requirements>,
    input: unknown
  ) =>
    Schema.decodeUnknownEffect(Schema.toType(schema))(input).pipe(
      Effect.mapError(() => new ReadinessInputError({ operation, reason: "invalid-request" }))
    )

  const quarantineMalformed = Effect.fn("ReadinessRepository.quarantineMalformed")(function*(
    malformed: MalformedReadinessRecord
  ) {
    const diagnostic = readinessQuarantineDiagnostic(malformed.error)
    if (diagnostic !== null) {
      yield* quarantineRow({
        workspaceId: malformed.error.workspaceId,
        ...diagnostic,
        recordKey: malformed.error.recordKey,
        observedAt: yield* DateTime.now,
        row: malformed.row
      })
    }
    return yield* malformed.error
  })

  const isMalformedReadinessRecord = (failure: unknown): failure is MalformedReadinessRecord =>
    Predicate.isTagged("MalformedReadinessRecord")(failure) &&
    Predicate.hasProperty(failure, "error") &&
    Predicate.isTagged("PersistedRecordError")(failure.error) &&
    Predicate.hasProperty(failure, "row")

  const transactCaptured = <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
    database.transaction(effect).pipe(
      mapPersistenceOperation("readiness.transaction"),
      Effect.result,
      Effect.flatMap(
        (
          result
        ): Effect.Effect<
          Value,
          Failure | PersistedRecordError | PersistenceOperationError | QuarantineWriteError,
          Requirements
        > => {
          if (Result.isSuccess(result)) return Effect.succeed(result.success)
          return isMalformedReadinessRecord(result.failure)
            ? quarantineMalformed(result.failure)
            : Effect.fail(result.failure)
        }
      )
    )

  const registerRule = Effect.fn("ReadinessRepository.registerRule")(function*(input: unknown) {
    const request = yield* decodeInput("register-rule", RegisterReadinessRuleRequest, input)
    return yield* transactCaptured(rules.register(request))
  })

  const commitEnvironment = Effect.fn("ReadinessRepository.commitEnvironment")(function*(input: unknown) {
    const request = yield* decodeInput("commit-environment", CommitEnvironmentReadinessAssessmentRequest, input)
    return yield* transactCaptured(assessments.commitEnvironment(request))
  })

  const commitRelease = Effect.fn("ReadinessRepository.commitRelease")(function*(input: unknown) {
    const request = yield* decodeInput("commit-release", CommitReleaseReadinessAssessmentRequest, input)
    return yield* transactCaptured(assessments.commitRelease(request))
  })

  type CurrentRow = Success<ReturnType<typeof assessments.currentRows>>[number]
  type DecodedCurrentRecord = Success<ReturnType<typeof assessments.decodeCurrentRow>>
  const verifyCurrentMaterialization = Effect.fn("ReadinessRepository.verifyCurrentMaterialization")(
    function*(input: {
      readonly workspaceId: WorkspaceId
      readonly rows: ReadonlyArray<CurrentRow>
      readonly records: ReadonlyArray<DecodedCurrentRecord>
    }) {
      const materialization = yield* assessments.loadAssessmentMaterialization({
        workspaceId: input.workspaceId,
        assessmentIds: input.records.map(({ assessment }) => assessment.assessmentId)
      })
      yield* Effect.forEach(
        input.records,
        (record, index) =>
          assessments.verifyAssessmentMaterialization(record.assessment, input.rows[index], materialization),
        { discard: true }
      )
    }
  )

  const readCurrent = Effect.fn("ReadinessRepository.readCurrent")(function*(input: unknown) {
    const request = yield* decodeInput("read-current", ReadCurrentReadinessAssessmentRequest, input)
    const records = yield* transactCaptured(
      Effect.gen(function*() {
        const rows = yield* assessments.currentRows(request)
        const decoded = yield* Effect.forEach(rows, (row) => assessments.decodeCurrentRow(row, request))
        yield* verifyCurrentMaterialization({
          workspaceId: request.workspaceId,
          rows,
          records: decoded
        })
        return decoded
      })
    )
    const decoded = records[0]
    if (decoded === undefined) return { _tag: request._tag, record: null }
    if (records.length !== 1) {
      return yield* new PersistedRecordError({
        workspaceId: request.workspaceId,
        recordKind: request._tag === "environment" ? "readiness-environment-head" : "readiness-release-head",
        recordKey: request._tag === "environment" ? request.environmentId : request.releaseId,
        diagnosticCode: request._tag === "environment"
          ? "readiness-environment-head-schema-invalid"
          : "readiness-release-head-schema-invalid"
      })
    }
    if (request._tag === "environment" && decoded.assessment._tag === "environment") {
      const record: CurrentEnvironmentReadinessAssessmentRecord = {
        ...decoded,
        assessment: decoded.assessment
      }
      return { _tag: "environment", record } satisfies ReadCurrentReadinessAssessmentResult
    }
    if (request._tag === "release" && decoded.assessment._tag === "release") {
      const record: CurrentReleaseReadinessAssessmentRecord = {
        ...decoded,
        assessment: decoded.assessment
      }
      return { _tag: "release", record } satisfies ReadCurrentReadinessAssessmentResult
    }
    return yield* new PersistedRecordError({
      workspaceId: request.workspaceId,
      recordKind: request._tag === "environment" ? "readiness-environment-head" : "readiness-release-head",
      recordKey: request._tag === "environment" ? request.environmentId : request.releaseId,
      diagnosticCode: "readiness-head-assessment-mismatch"
    })
  })

  const readCurrentReleases = Effect.fn("ReadinessRepository.readCurrentReleases")(function*(input: unknown) {
    const request = yield* decodeInput(
      "read-current-releases",
      ReadCurrentReleaseReadinessAssessmentsRequest,
      input
    )
    const decoded = yield* transactCaptured(
      Effect.gen(function*() {
        const rows = yield* assessments.currentReleaseRows(request)
        const records = yield* Effect.forEach(
          rows,
          (row) => assessments.decodeCurrentReleaseRow(row, request.workspaceId)
        )
        yield* verifyCurrentMaterialization({
          workspaceId: request.workspaceId,
          rows,
          records
        })
        return records
      })
    )
    const records: Array<CurrentReleaseReadinessAssessmentRecord> = decoded.flatMap((record) =>
      record.assessment._tag === "release"
        ? [{ ...record, assessment: record.assessment }]
        : []
    )
    const releaseIds = records.map(({ assessment }) => assessment.candidate.scope.releaseId)
    const requestedReleaseIds = new Set(request.releaseIds)
    if (
      records.length !== decoded.length ||
      new Set(releaseIds).size !== releaseIds.length ||
      releaseIds.some((releaseId) => !requestedReleaseIds.has(releaseId))
    ) {
      return yield* new PersistedRecordError({
        workspaceId: request.workspaceId,
        recordKind: "readiness-release-head",
        recordKey: "release-batch",
        diagnosticCode: "readiness-head-assessment-mismatch"
      })
    }
    return records satisfies ReadCurrentReleaseReadinessAssessmentsResult
  })

  const readHistory = Effect.fn("ReadinessRepository.readHistory")(function*(input: unknown) {
    const request = yield* decodeInput("read-history", ReadReadinessHistoryRequest, input)
    const snapshot = yield* transactCaptured(
      Effect.gen(function*() {
        const rows = yield* assessments.historyRows(request)
        const pageRows = rows.slice(0, request.limit)
        const decoded = yield* Effect.forEach(pageRows, (row) => assessments.decodeHistoryRow(row, request))
        const materialization = yield* assessments.loadAssessmentMaterialization({
          workspaceId: request.workspaceId,
          assessmentIds: decoded.map(({ assessment }) => assessment.assessmentId)
        })
        yield* Effect.forEach(
          decoded,
          (record, index) =>
            assessments.verifyAssessmentMaterialization(record.assessment, pageRows[index], materialization),
          { discard: true }
        )
        return { decoded, hasMore: rows.length > request.limit }
      })
    )
    const { decoded } = snapshot
    const last = decoded.at(-1)
    const nextBeforeHeadRevision = snapshot.hasMore && last !== undefined ? last.headRevision : null
    if (request._tag === "environment") {
      const records: Array<EnvironmentReadinessAssessmentRecord> = decoded.flatMap((record) =>
        record.assessment._tag === "environment"
          ? [{ ...record, assessment: record.assessment }]
          : []
      )
      if (records.length !== decoded.length) {
        return yield* new PersistedRecordError({
          workspaceId: request.workspaceId,
          recordKind: "readiness-assessment",
          recordKey: request.releaseId,
          diagnosticCode: "readiness-assessment-identity-mismatch"
        })
      }
      return {
        _tag: "environment",
        records,
        nextBeforeHeadRevision
      } satisfies ReadReadinessHistoryResult
    }
    const records: Array<ReleaseReadinessAssessmentRecord> = decoded.flatMap((record) =>
      record.assessment._tag === "release"
        ? [{ ...record, assessment: record.assessment }]
        : []
    )
    if (records.length !== decoded.length) {
      return yield* new PersistedRecordError({
        workspaceId: request.workspaceId,
        recordKind: "readiness-assessment",
        recordKey: request.releaseId,
        diagnosticCode: "readiness-assessment-identity-mismatch"
      })
    }
    return { _tag: "release", records, nextBeforeHeadRevision } satisfies ReadReadinessHistoryResult
  })

  const enqueueInvalidation = Effect.fn("ReadinessRepository.enqueueInvalidation")(function*(input: unknown) {
    const request = yield* decodeInput("enqueue-invalidation", EnqueueReadinessInvalidationRequest, input)
    return yield* database
      .transaction(queue.enqueue(request))
      .pipe(mapPersistenceOperation("readiness.enqueue-invalidation"))
  })

  const enqueueAffected = Effect.fn("ReadinessRepository.enqueueAffected")(function*(input: unknown) {
    const request = yield* decodeInput("enqueue-affected", EnqueueAffectedReadinessRequest, input)
    return yield* database
      .transaction(queue.enqueueAffected(request))
      .pipe(mapPersistenceOperation("readiness.enqueue-affected"))
  })

  const claimInvalidation = Effect.fn("ReadinessRepository.claimInvalidation")(function*(input: unknown) {
    const request = yield* decodeInput("claim-invalidation", ClaimReadinessInvalidationRequest, input)
    return yield* database
      .transaction(queue.claim(request))
      .pipe(mapPersistenceOperation("readiness.claim-invalidation"))
  })

  const enqueueDue = Effect.fn("ReadinessRepository.enqueueDue")(function*(input: unknown) {
    const request = yield* decodeInput("enqueue-due", EnqueueDueReadinessEvaluationsRequest, input)
    return yield* database.transaction(queue.enqueueDue(request)).pipe(mapPersistenceOperation("readiness.enqueue-due"))
  })

  return {
    claimInvalidation,
    commitEnvironment,
    commitRelease,
    enqueueAffected,
    enqueueDue,
    enqueueInvalidation,
    readCurrent,
    readCurrentReleases,
    readHistory,
    registerRule
  }
})

/** Deep persistence interface for digest-bound readiness assessments and reevaluation work. */
export interface ReadinessRepositoryService extends Success<typeof makeReadinessRepository> {}

/** Effect service binding readiness audit records, current heads, schedules, and queues. */
export class ReadinessRepository extends Context.Service<ReadinessRepository, ReadinessRepositoryService>()(
  "@knpkv/control-center/ReadinessRepository"
) {
  static readonly layer = Layer.effect(ReadinessRepository, makeReadinessRepository)
}
