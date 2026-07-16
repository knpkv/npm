import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"

import type { ReadinessAssessmentId, WorkspaceId } from "../../../../domain/identifiers.js"
import type { ReadinessAssessment } from "../../../../domain/readiness/index.js"
import { Database } from "../../Database.js"
import { PersistedRecordError } from "../../errors.js"
import { captureMalformedReadinessRow } from "./quarantine.js"
import {
  RawReadinessRow,
  ReadinessMaterializedEvidenceRow,
  ReadinessMaterializedReleaseChildRow,
  ReadinessMaterializedSourceRow
} from "./rows.js"

type EvidenceRow = typeof ReadinessMaterializedEvidenceRow.Type
type SourceRow = typeof ReadinessMaterializedSourceRow.Type
type ChildRow = typeof ReadinessMaterializedReleaseChildRow.Type

interface MaterializationRows {
  readonly evidence: ReadonlyArray<EvidenceRow>
  readonly sources: ReadonlyArray<SourceRow>
  readonly children: ReadonlyArray<ChildRow>
}

export interface GroupedMaterialization {
  readonly evidence: ReadonlyMap<ReadinessAssessmentId, ReadonlyArray<EvidenceRow>>
  readonly sources: ReadonlyMap<ReadinessAssessmentId, ReadonlyArray<SourceRow>>
  readonly children: ReadonlyMap<ReadinessAssessmentId, ReadonlyArray<ChildRow>>
}

const groupByAssessment = <Row extends { readonly assessmentId: ReadinessAssessmentId }>(
  rows: ReadonlyArray<Row>
): ReadonlyMap<ReadinessAssessmentId, ReadonlyArray<Row>> => {
  const grouped = new Map<ReadinessAssessmentId, Array<Row>>()
  for (const row of rows) {
    const group = grouped.get(row.assessmentId)
    if (group === undefined) grouped.set(row.assessmentId, [row])
    else group.push(row)
  }
  return grouped
}

/** Index each persisted dependency exactly once before aggregate verification. */
export const groupReadinessMaterialization = (rows: MaterializationRows): GroupedMaterialization => ({
  evidence: groupByAssessment(rows.evidence),
  sources: groupByAssessment(rows.sources),
  children: groupByAssessment(rows.children)
})

export const makeReadinessMaterialization = Effect.gen(function*() {
  const { sql } = yield* Database

  const malformed = (workspaceId: WorkspaceId, row: typeof RawReadinessRow.Type) =>
    new PersistedRecordError({
      workspaceId,
      recordKind: "readiness-assessment",
      recordKey: Predicate.hasProperty(row, "assessmentId") && typeof row.assessmentId === "string"
        ? row.assessmentId
        : "unknown-materialization",
      diagnosticCode: "readiness-assessment-materialization-mismatch"
    })

  const load = Effect.fn("ReadinessMaterialization.load")(function*(input: {
    readonly workspaceId: WorkspaceId
    readonly assessmentIds: ReadonlyArray<ReadinessAssessmentId>
  }) {
    if (input.assessmentIds.length === 0) {
      return groupReadinessMaterialization({ evidence: [], sources: [], children: [] })
    }
    const evidenceRows = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: RawReadinessRow,
      execute: () =>
        sql`SELECT assessment_id AS assessmentId, evidence_id AS evidenceId
            FROM readiness_assessment_evidence
            WHERE workspace_id = ${input.workspaceId}
              AND assessment_id IN ${sql.in(input.assessmentIds)}
            ORDER BY assessment_id, evidence_id`
    })(undefined)
    const sourceRows = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: RawReadinessRow,
      execute: () =>
        sql`SELECT assessment_id AS assessmentId, plugin_connection_id AS pluginConnectionId
            FROM readiness_assessment_sources
            WHERE workspace_id = ${input.workspaceId}
              AND assessment_id IN ${sql.in(input.assessmentIds)}
            ORDER BY assessment_id, plugin_connection_id`
    })(undefined)
    const childRows = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: RawReadinessRow,
      execute: () =>
        sql`SELECT release_assessment_id AS assessmentId, environment_id AS environmentId,
                   environment_assessment_id AS environmentAssessmentId,
                   environment_candidate_digest AS environmentCandidateDigest
            FROM readiness_release_children
            WHERE workspace_id = ${input.workspaceId}
              AND release_assessment_id IN ${sql.in(input.assessmentIds)}
            ORDER BY release_assessment_id, environment_id`
    })(undefined)
    const evidence = yield* Effect.forEach(
      evidenceRows,
      (row) =>
        Schema.decodeUnknownEffect(ReadinessMaterializedEvidenceRow)(row).pipe(
          Effect.mapError(() => malformed(input.workspaceId, row)),
          captureMalformedReadinessRow(row)
        )
    )
    const sources = yield* Effect.forEach(
      sourceRows,
      (row) =>
        Schema.decodeUnknownEffect(ReadinessMaterializedSourceRow)(row).pipe(
          Effect.mapError(() => malformed(input.workspaceId, row)),
          captureMalformedReadinessRow(row)
        )
    )
    const children = yield* Effect.forEach(
      childRows,
      (row) =>
        Schema.decodeUnknownEffect(ReadinessMaterializedReleaseChildRow)(row).pipe(
          Effect.mapError(() => malformed(input.workspaceId, row)),
          captureMalformedReadinessRow(row)
        )
    )
    return groupReadinessMaterialization({ evidence, sources, children })
  })

  const verify = Effect.fn("ReadinessMaterialization.verify")(function*(
    assessment: ReadinessAssessment,
    row: unknown,
    grouped: Effect.Success<ReturnType<typeof load>>
  ) {
    const evidence = grouped.evidence.get(assessment.assessmentId) ?? []
    const sources = grouped.sources.get(assessment.assessmentId) ?? []
    const children = grouped.children.get(assessment.assessmentId) ?? []
    const expectedChildren = assessment._tag === "release"
      ? assessment.environments.map(({ assessmentId, candidateDigest, environmentId }) => ({
        assessmentId: assessment.assessmentId,
        environmentId,
        environmentAssessmentId: assessmentId,
        environmentCandidateDigest: candidateDigest
      }))
      : []
    const matches = JSON.stringify(evidence.map(({ assessmentId, evidenceId }) => ({ assessmentId, evidenceId }))) ===
        JSON.stringify(
          assessment.evidenceIds.map((evidenceId) => ({ assessmentId: assessment.assessmentId, evidenceId }))
        ) &&
      JSON.stringify(sources.map(({ assessmentId, pluginConnectionId }) => ({ assessmentId, pluginConnectionId }))) ===
        JSON.stringify(
          assessment.sourceFreshness.map(({ pluginConnectionId }) => ({
            assessmentId: assessment.assessmentId,
            pluginConnectionId
          }))
        ) &&
      JSON.stringify(children) === JSON.stringify(expectedChildren)
    if (!matches) {
      return yield* captureMalformedReadinessRow(row)(
        Effect.fail(
          new PersistedRecordError({
            workspaceId: assessment.candidate.workspaceId,
            recordKind: "readiness-assessment",
            recordKey: assessment.assessmentId,
            diagnosticCode: "readiness-assessment-materialization-mismatch"
          })
        )
      )
    }
  })

  return { load, verify }
})
