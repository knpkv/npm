/** Authenticated HTTP routes. Every route reads; payload schemas live in shared/contracts. */
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSecurity } from "effect/http-api"
import {
  ApiError,
  ForbiddenApiError,
  LimitsReport,
  RangeQuery,
  ServerStatus,
  SessionsQuery,
  SessionsReport,
  UnauthorizedApiError,
  UsageQuery,
  UsageReport
} from "../shared/contracts.js"

export * from "../shared/contracts.js"

export class OwnerSessionAuth extends HttpApiMiddleware.Service<OwnerSessionAuth>()(
  "@knpkv/agent-usage/OwnerSessionAuth",
  {
    error: [UnauthorizedApiError, ForbiddenApiError],
    security: {
      ownerCookie: HttpApiSecurity.apiKey({ in: "cookie", key: "agent_usage_owner" })
    }
  }
) {}

export class UsageApiGroup extends HttpApiGroup.make("usage")
  .add(HttpApiEndpoint.get("usage", "/usage", { query: UsageQuery, success: UsageReport, error: ApiError }))
  .add(HttpApiEndpoint.get("limits", "/limits", { query: RangeQuery, success: LimitsReport, error: ApiError }))
  .add(HttpApiEndpoint.get("sessions", "/sessions", { query: SessionsQuery, success: SessionsReport, error: ApiError }))
  .add(HttpApiEndpoint.get("status", "/status", { success: ServerStatus }))
  .prefix("/api")
{}

export class AgentUsageApi extends HttpApi.make("AgentUsageApi").add(UsageApiGroup).middleware(OwnerSessionAuth) {}
