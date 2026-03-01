import { HttpApiBuilder } from "@effect/platform"
import { SandboxService } from "@knpkv/codecommit-core"
import type { SandboxRow } from "@knpkv/codecommit-core/CacheService.js"
import type { SandboxStatus } from "@knpkv/codecommit-core/Domain.js"
import { Effect } from "effect"
import { ApiError, CodeCommitApi, type SandboxResponse } from "../Api.js"

// Explicit field mapping — prevents leaking server-internal fields (e.g. workspacePath)
// if SandboxRow gains new fields. Do not replace with object spread.
export const encodeSandbox = (row: SandboxRow): typeof SandboxResponse.Type => ({
  id: row.id,
  pullRequestId: row.pullRequestId,
  awsAccountId: row.awsAccountId,
  repositoryName: row.repositoryName,
  sourceBranch: row.sourceBranch,
  containerId: row.containerId,
  port: row.port,
  status: row.status as SandboxStatus,
  statusDetail: row.statusDetail,
  logs: row.logs,
  error: row.error,
  createdAt: row.createdAt,
  lastActivityAt: row.lastActivityAt
})

export const SandboxLive = HttpApiBuilder.group(CodeCommitApi, "sandbox", (handlers) =>
  Effect.gen(function*() {
    const sandboxService = yield* SandboxService.SandboxService

    return handlers
      .handle("create", ({ payload }) =>
        sandboxService.create(payload).pipe(
          Effect.map(encodeSandbox),
          Effect.mapError((e) => new ApiError({ message: e.message }))
        ))
      .handle("list", () =>
        sandboxService.list().pipe(
          Effect.map((rows) => rows.map(encodeSandbox)),
          Effect.mapError((e) => new ApiError({ message: e.message }))
        ))
      .handle("get", ({ path }) =>
        sandboxService.get(path.sandboxId).pipe(
          Effect.map(encodeSandbox),
          Effect.mapError((e) => new ApiError({ message: e.message }))
        ))
      .handle("stop", ({ path }) =>
        sandboxService.stop(path.sandboxId).pipe(
          Effect.map(() => "ok"),
          Effect.mapError((e) => new ApiError({ message: e.message }))
        ))
      .handle("restart", ({ path }) =>
        sandboxService.restart(path.sandboxId).pipe(
          Effect.map(() => "ok"),
          Effect.mapError((e) => new ApiError({ message: e.message }))
        ))
      .handle("delete", ({ path }) =>
        sandboxService.cleanup(path.sandboxId).pipe(
          Effect.map(() => "ok"),
          Effect.mapError((e) => new ApiError({ message: e.message }))
        ))
  }))
