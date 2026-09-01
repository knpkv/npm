import { SandboxService } from "@knpkv/codecommit-core"
import type { SandboxRow } from "@knpkv/codecommit-core/CacheService.js"
import { SandboxStatus } from "@knpkv/codecommit-core/Domain.js"
import { Effect, Predicate, Schema } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiError, CodeCommitApi, type SandboxResponse } from "../Api.js"

// Explicit field mapping — prevents leaking server-internal fields (e.g. workspacePath)
// if SandboxRow gains new fields. Do not replace with object spread.
export const encodeSandbox = (row: SandboxRow): typeof SandboxResponse.Type => ({
  id: row.id,
  pullRequestId: row.pullRequestId,
  awsAccountId: row.awsAccountId,
  repositoryName: row.repositoryName,
  region: row.region ?? "",
  sourceBranch: row.sourceBranch,
  containerId: row.containerId,
  port: row.port,
  status: Schema.decodeUnknownSync(SandboxStatus)(row.status),
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
      .handle("get", ({ params }) =>
        sandboxService.get(params.sandboxId).pipe(
          Effect.map(encodeSandbox),
          Effect.mapError((e) => new ApiError({ message: e.message }))
        ))
      .handleRaw("credentials", ({ params }) =>
        sandboxService.get(params.sandboxId).pipe(
          Effect.flatMap((row) =>
            row.accessPassword === null
              ? Effect.fail(new ApiError({ message: "Sandbox has no authenticated access credential" }))
              : HttpServerResponse.json(
                { password: row.accessPassword },
                { headers: { "cache-control": "no-store" } }
              ).pipe(Effect.mapError((error) => new ApiError({ message: error.message })))
          ),
          Effect.mapError((e) => Predicate.isTagged(e, "ApiError") ? e : new ApiError({ message: e.message }))
        ))
      .handle("stop", ({ params }) =>
        sandboxService.stop(params.sandboxId).pipe(
          Effect.map(() => "ok"),
          Effect.mapError((e) => new ApiError({ message: e.message }))
        ))
      .handle("restart", ({ params }) =>
        sandboxService.restart(params.sandboxId).pipe(
          Effect.map(() => "ok"),
          Effect.mapError((e) => new ApiError({ message: e.message }))
        ))
      .handle("delete", ({ params }) =>
        sandboxService.cleanup(params.sandboxId).pipe(
          Effect.map(() => "ok"),
          Effect.mapError((e) => new ApiError({ message: e.message }))
        ))
  }))
