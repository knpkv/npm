/**
 * @title Audit log handler — query and export API call history
 *
 * @module
 */
import { AuditLogRepo } from "@knpkv/codecommit-core/PermissionService/AuditLog.js"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ApiError, CodeCommitApi } from "../Api.js"

export const AuditLive = HttpApiBuilder.group(
  CodeCommitApi,
  "audit",
  (handlers) =>
    Effect.gen(function*() {
      const auditLog = yield* AuditLogRepo

      return handlers
        .handle("list", ({ query }) =>
          auditLog.findAll({
            limit: query.limit ?? 50,
            offset: query.offset ?? 0,
            operation: query.operation,
            accountProfile: query.accountProfile,
            permissionState: query.permissionState,
            from: query.from,
            to: query.to,
            search: query.search
          }).pipe(
            Effect.tapError((e) => Effect.logWarning("Audit operation failed", e)),
            Effect.mapError(() => new ApiError({ message: "Audit query failed" }))
          ))
        .handle("export", ({ query }) =>
          auditLog.exportAll({
            from: query.from,
            to: query.to
          }).pipe(
            Effect.tapError((e) => Effect.logWarning("Audit operation failed", e)),
            Effect.mapError(() => new ApiError({ message: "Audit query failed" }))
          ))
        .handle("clear", () =>
          auditLog.clearAll().pipe(
            Effect.map((deleted) => ({ deleted })),
            Effect.tapError((e) => Effect.logWarning("Audit operation failed", e)),
            Effect.mapError(() => new ApiError({ message: "Audit query failed" }))
          ))
    })
)
