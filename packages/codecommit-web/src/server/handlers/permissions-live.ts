/**
 * @title Permissions handler — respond to prompts, manage permission state
 *
 * @module
 */
import { PermissionService } from "@knpkv/codecommit-core"
import { PermissionGateLiveTag } from "@knpkv/codecommit-core/PermissionService/PermissionGateLive.js"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { ApiError, CodeCommitApi } from "../Api.js"

const defaultPermissionState = "allow"

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
              state: permissions[name] ?? defaultPermissionState,
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
        .handle("updateCategory", ({ payload }) =>
          // Saved and applied to the waiting calls as one step: an interrupted request can't leave a
          // saved grant whose waiting calls sit until they time out.
          permService.setCategory(payload.category, payload.state).pipe(
            // Calls already waiting in this category follow the saved grant (or refusal); "allow" means
            // "ask each time", so they keep waiting for their own answer.
            Effect.andThen(
              payload.state === "always_allow"
                ? gate.resolveCategory(payload.category, "allow_once")
                : payload.state === "deny"
                ? gate.resolveCategory(payload.category, "deny")
                : Effect.void
            ),
            Effect.uninterruptible,
            Effect.map(() => "ok"),
            Effect.mapError((error) => new ApiError({ message: error.message }))
          ))
        .handle("auditSettings", () =>
          Effect.all({
            enabled: permService.isAuditEnabled(),
            retentionDays: permService.getAuditRetention()
          }))
        .handle("updateAuditSettings", ({ payload }) =>
          permService.setAudit(payload).pipe(
            Effect.map(() => "ok"),
            Effect.mapError((e) => new ApiError({ message: String(e) }))
          ))
    })
)
