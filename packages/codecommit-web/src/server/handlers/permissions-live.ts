/**
 * @title Permissions handler — respond to prompts, manage permission state
 *
 * @module
 */
import { HttpApiBuilder } from "@effect/platform"
import { PermissionService } from "@knpkv/codecommit-core"
import { PermissionGateLiveTag } from "@knpkv/codecommit-core/PermissionService/PermissionGateLive.js"
import { Effect } from "effect"
import { ApiError, CodeCommitApi } from "../Api.js"

export const PermissionsLive = HttpApiBuilder.group(
  CodeCommitApi,
  "permissions",
  (handlers) =>
    Effect.gen(function*() {
      const permService = yield* PermissionService.PermissionService
      const gate = yield* PermissionGateLiveTag

      return handlers
        .handle("respond", ({ payload }) =>
          gate.resolve(payload.id, payload.response).pipe(
            Effect.map(() => "ok"),
            Effect.mapError((e) => new ApiError({ message: String(e) }))
          ))
        .handle("list", () =>
          Effect.gen(function*() {
            const permissions = yield* permService.getAll()
            const ops = PermissionService.allOperations()
            return ops.map(([name, meta]) => ({
              operation: name,
              state: permissions[name] ?? ("allow" as const),
              category: meta.category,
              description: meta.description
            }))
          }))
        .handle("update", ({ payload }) =>
          permService.set(payload.operation, payload.state).pipe(
            Effect.map(() => "ok"),
            Effect.mapError((e) => new ApiError({ message: String(e) }))
          ))
        .handle("reset", () => permService.resetAll().pipe(Effect.map(() => "ok")))
        .handle("auditSettings", ({ payload }) =>
          permService.setAudit(payload).pipe(
            Effect.map(() => "ok"),
            Effect.mapError((e) => new ApiError({ message: String(e) }))
          ))
    })
)
