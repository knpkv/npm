import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"

import type { WorkspaceId } from "../../../domain/identifiers.js"
import {
  PersistenceOperationError,
  RecordAlreadyExistsError,
  RecordNotFoundError,
  RevisionConflictError
} from "../errors.js"

const ChangesRow = Schema.Struct({ changes: Schema.Number })
const RevisionRow = Schema.Struct({ revision: Schema.Number })

/** Parameters shared by optimistic-concurrency failure resolution. */
export interface ResolveCasFailureOptions {
  readonly workspaceId: WorkspaceId
  readonly recordKind: string
  readonly recordKey: string
  readonly expectedRevision: number
  readonly findActualRevision: Effect.Effect<Option.Option<{ readonly revision: number }>, unknown>
}

/** Identity used to translate a unique-constraint violation into a domain error. */
export interface AlreadyExistsOptions {
  readonly workspaceId: WorkspaceId
  readonly recordKind: string
  readonly recordKey: string
}

const isUniqueViolation = (error: unknown): error is SqlError.SqlError =>
  SqlError.isSqlError(error) && error.reason._tag === "UniqueViolation"

type PersistenceInfrastructureError = SqlError.SqlError | Schema.SchemaError

const isPersistenceInfrastructureError = (error: unknown): error is PersistenceInfrastructureError =>
  SqlError.isSqlError(error) || Schema.isSchemaError(error)

/** Preserve operational SQL failures while classifying duplicate identities. */
export const mapAlreadyExists =
  (options: AlreadyExistsOptions) =>
  <Success, Failure, Requirements>(effect: Effect.Effect<Success, Failure, Requirements>) =>
    effect.pipe(
      Effect.catchIf(isUniqueViolation, () =>
        new RecordAlreadyExistsError({
          workspaceId: options.workspaceId,
          recordKind: options.recordKind,
          recordKey: options.recordKey
        }))
    )

/** Hide driver details at repository boundaries while retaining an internal diagnostic. */
export function mapPersistenceOperation(
  operation: string
): <Success, Failure, Requirements>(
  effect: Effect.Effect<Success, Failure, Requirements>
) => Effect.Effect<
  Success,
  Exclude<Failure, PersistenceInfrastructureError> | PersistenceOperationError,
  Requirements
>
export function mapPersistenceOperation(operation: string) {
  return <Success, Failure, Requirements>(
    effect: Effect.Effect<Success, Failure, Requirements>
  ) =>
    Effect.catchIf(
      effect,
      isPersistenceInfrastructureError,
      (error) =>
        Effect.logError("Control Center persistence operation failed", {
          failureClass: SqlError.isSqlError(error) ? error.reason._tag : "SchemaError",
          operation
        }).pipe(
          Effect.andThen(new PersistenceOperationError({ operation }))
        )
    )
}

/** Read the affected-row count of the immediately preceding SQLite statement. */
export const readChanges = (sql: SqlClient.SqlClient): Effect.Effect<number, unknown> => {
  const query = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ChangesRow,
    execute: () => sql`SELECT changes() AS changes`
  })
  return query(undefined).pipe(Effect.map(({ changes }) => changes))
}

/** Build a workspace-scoped current-revision lookup for a mutable record. */
export const revisionLookup = (
  execute: () => Effect.Effect<ReadonlyArray<unknown>, unknown>
): Effect.Effect<Option.Option<{ readonly revision: number }>, unknown> =>
  SqlSchema.findOneOption({ Request: Schema.Void, Result: RevisionRow, execute })(undefined)

/** Distinguish a missing record from an optimistic-concurrency conflict. */
export const resolveCasFailure = Effect.fn("resolveCasFailure")(function*(
  options: ResolveCasFailureOptions
) {
  const actual = yield* options.findActualRevision
  if (Option.isNone(actual)) {
    return yield* new RecordNotFoundError({
      workspaceId: options.workspaceId,
      recordKind: options.recordKind,
      recordKey: options.recordKey
    })
  }
  return yield* new RevisionConflictError({
    workspaceId: options.workspaceId,
    recordKind: options.recordKind,
    recordKey: options.recordKey,
    expectedRevision: options.expectedRevision,
    actualRevision: actual.value.revision
  })
})
