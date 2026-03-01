import * as SqlClient from "@effect/sql/SqlClient"
import * as SqlSchema from "@effect/sql/SqlSchema"
import { Clock, Effect, Option, Schema } from "effect"
import type { SandboxId, SandboxStatus } from "../../Domain.js"
import { CacheError } from "../CacheError.js"
import { DatabaseLive } from "../Database.js"
import { EventsHub, RepoChange } from "../EventsHub.js"

export const SandboxRow = Schema.Struct({
  id: Schema.String,
  pullRequestId: Schema.String,
  awsAccountId: Schema.String,
  repositoryName: Schema.String,
  sourceBranch: Schema.String,
  containerId: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Number),
  workspacePath: Schema.String,
  status: Schema.String,
  statusDetail: Schema.NullOr(Schema.String),
  logs: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  lastActivityAt: Schema.String
})

export type SandboxRow = typeof SandboxRow.Type

export interface InsertSandbox {
  readonly id: string
  readonly pullRequestId: string
  readonly awsAccountId: string
  readonly repositoryName: string
  readonly sourceBranch: string
  readonly workspacePath: string
  readonly status: string
  readonly createdAt: string
  readonly lastActivityAt: string
}

const cacheError = (op: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) => new CacheError({ operation: `SandboxRepo.${op}`, cause })),
    Effect.withSpan(`SandboxRepo.${op}`, { captureStackTrace: false })
  )

const isoNow = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()))

export class SandboxRepo extends Effect.Service<SandboxRepo>()("SandboxRepo", {
  dependencies: [DatabaseLive, EventsHub.Default],
  effect: Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const hub = yield* EventsHub

    const publish = hub.publish(RepoChange.Sandboxes())

    const findById_ = SqlSchema.findOne({
      Result: SandboxRow,
      Request: Schema.Struct({ id: Schema.String }),
      execute: (req) => sql`SELECT * FROM sandboxes WHERE id = ${req.id}`
    })

    const findByPr_ = SqlSchema.findOne({
      Result: SandboxRow,
      Request: Schema.Struct({ awsAccountId: Schema.String, pullRequestId: Schema.String }),
      execute: (req) =>
        sql`SELECT * FROM sandboxes
            WHERE aws_account_id = ${req.awsAccountId}
              AND pull_request_id = ${req.pullRequestId}
              AND status NOT IN ('stopped', 'error')`
    })

    const findActive_ = SqlSchema.findAll({
      Result: SandboxRow,
      Request: Schema.Void,
      execute: () =>
        sql`SELECT * FROM sandboxes
            WHERE status IN ('creating', 'cloning', 'starting', 'running')
            ORDER BY created_at DESC`
    })

    const findAll_ = SqlSchema.findAll({
      Result: SandboxRow,
      Request: Schema.Void,
      execute: () => sql`SELECT * FROM sandboxes ORDER BY created_at DESC`
    })

    return {
      insert: (sandbox: InsertSandbox) =>
        sql`INSERT INTO sandboxes (id, pull_request_id, aws_account_id, repository_name, source_branch, workspace_path, status, created_at, last_activity_at)
            VALUES (${sandbox.id}, ${sandbox.pullRequestId}, ${sandbox.awsAccountId}, ${sandbox.repositoryName}, ${sandbox.sourceBranch}, ${sandbox.workspacePath}, ${sandbox.status}, ${sandbox.createdAt}, ${sandbox.lastActivityAt})`
          .pipe(
            Effect.tap(() => publish),
            cacheError("insert")
          ),

      updateStatus: (
        id: SandboxId,
        status: SandboxStatus,
        extra?: { containerId?: string; port?: number; error?: string }
      ) =>
        isoNow.pipe(
          Effect.flatMap((now) =>
            sql`UPDATE sandboxes SET
                status = ${status},
                last_activity_at = ${now}
                ${extra?.containerId ? sql`, container_id = ${extra.containerId}` : sql``}
                ${extra?.port ? sql`, port = ${extra.port}` : sql``}
                ${extra?.error ? sql`, error = ${extra.error}` : sql``}
                WHERE id = ${id}`.pipe(
              Effect.tap(() => publish)
            )
          ),
          cacheError("updateStatus")
        ),

      findById: (id: SandboxId) =>
        findById_({ id }).pipe(
          Effect.flatMap(Option.match({
            onNone: () =>
              Effect.fail(new CacheError({ operation: "SandboxRepo.findById", cause: `Sandbox ${id} not found` })),
            onSome: Effect.succeed
          })),
          Effect.withSpan("SandboxRepo.findById", { captureStackTrace: false })
        ),

      findByPr: (awsAccountId: string, pullRequestId: string) =>
        findByPr_({ awsAccountId, pullRequestId }).pipe(cacheError("findByPr")),

      findActive: () => findActive_(undefined as void).pipe(cacheError("findActive")),

      findAll: () => findAll_(undefined as void).pipe(cacheError("findAll")),

      delete: (id: SandboxId) =>
        sql`DELETE FROM sandboxes WHERE id = ${id}`.pipe(
          Effect.tap(() => publish),
          cacheError("delete")
        ),

      updateDetail: (id: SandboxId, detail: string) =>
        isoNow.pipe(
          Effect.flatMap((now) =>
            sql`UPDATE sandboxes SET
                status_detail = ${detail},
                last_activity_at = ${now}
                WHERE id = ${id}`.pipe(
              Effect.tap(() => publish)
            )
          ),
          cacheError("updateDetail")
        ),

      appendLog: (id: SandboxId, line: string) =>
        isoNow.pipe(
          Effect.flatMap((now) =>
            sql`UPDATE sandboxes SET
                logs = COALESCE(logs, '') || ${line + "\n"},
                last_activity_at = ${now}
                WHERE id = ${id}`.pipe(
              Effect.tap(() => publish)
            )
          ),
          cacheError("appendLog")
        ),

      updateActivity: (id: SandboxId) =>
        isoNow.pipe(
          Effect.flatMap((now) => sql`UPDATE sandboxes SET last_activity_at = ${now} WHERE id = ${id}`),
          cacheError("updateActivity")
        )
    } as const
  })
}) {}
