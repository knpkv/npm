/**
 * @title Audit log handler — query and export API call history
 *
 * @module
 */
import { HttpApiBuilder } from "@effect/platform"
import { AuditLogRepo } from "@knpkv/codecommit-core/PermissionService/AuditLog.js"
import { Effect } from "effect"
import { ApiError, CodeCommitApi } from "../Api.js"

export const AuditLive = HttpApiBuilder.group(
  CodeCommitApi,
  "audit",
  (handlers) =>
    Effect.gen(function*() {
      const auditLog = yield* AuditLogRepo

      return handlers
        .handle("list", ({ urlParams }) =>
          auditLog.findAll({
            limit: urlParams.limit ?? 50,
            offset: urlParams.offset ?? 0,
            operation: urlParams.operation,
            accountProfile: urlParams.accountProfile,
            permissionState: urlParams.permissionState,
            from: urlParams.from,
            to: urlParams.to,
            search: urlParams.search
          }).pipe(
            Effect.mapError((e) => new ApiError({ message: String(e) }))
          ))
        .handle("export", ({ urlParams }) =>
          auditLog.exportAll({
            from: urlParams.from,
            to: urlParams.to
          }).pipe(
            Effect.mapError((e) => new ApiError({ message: String(e) }))
          ))
        .handle("clear", () =>
          auditLog.clearAll().pipe(
            Effect.map((deleted) => ({ deleted })),
            Effect.mapError((e) => new ApiError({ message: String(e) }))
          ))
    })
)
