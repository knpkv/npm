/** Authenticated HTTP routes. Browser-safe payload schemas live in shared/contracts. */
import { SessionAgentSettings } from "@knpkv/jira-clockify/agent/agentSettings.js"
import { Schema } from "effect"
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity
} from "effect/unstable/httpapi"
import {
  ApiError,
  ConfirmPayload,
  Day,
  DescribeRowRequest,
  DescribeRowResponse,
  DescribeSavedEntryRequest,
  DescribeSavedEntryResponse,
  ForbiddenApiError,
  ManualPayload,
  OwnershipPayload,
  OwnershipResult,
  PlanExpiredError,
  ProposalRejectedError,
  SavedWeek,
  StandingPayload,
  StandingResult,
  UnauthorizedApiError,
  UpdateSavedEntryRequest,
  UpdateSavedEntryResponse,
  WeekPlan,
  WeekScope,
  WriteResult
} from "../shared/contracts.js"

export * from "../shared/contracts.js"
export class OwnerSessionAuth extends HttpApiMiddleware.Service<OwnerSessionAuth>()(
  "@knpkv/jcf-web/OwnerSessionAuth",
  {
    error: [UnauthorizedApiError, ForbiddenApiError],
    security: {
      ownerCookie: HttpApiSecurity.apiKey({ in: "cookie", key: "jcf_owner" })
    }
  }
) {}

export class WeekGroup extends HttpApiGroup.make("week")
  .add(HttpApiEndpoint.get("saved", "/saved", {
    query: Schema.Struct({ monday: Schema.optional(Day), only: Schema.optional(WeekScope) }),
    success: SavedWeek
  }))
  .add(
    HttpApiEndpoint.get("read", "/", {
      error: [ApiError, PlanExpiredError],
      query: Schema.Struct({ monday: Schema.optional(Day), only: Schema.optional(WeekScope) }),
      success: WeekPlan
    })
  )
  .add(HttpApiEndpoint.get("stream", "/stream", {
    error: [ApiError, PlanExpiredError],
    query: Schema.Struct({ monday: Schema.optional(Day), only: Schema.optional(WeekScope) }),
    success: HttpApiSchema.StreamUint8Array({ contentType: "application/x-ndjson" })
  }))
  .add(HttpApiEndpoint.get("recorded", "/recorded", {
    error: [ApiError, PlanExpiredError],
    query: Schema.Struct({ planId: Schema.String }),
    success: HttpApiSchema.StreamUint8Array({ contentType: "application/x-ndjson" })
  }))
  .add(HttpApiEndpoint.get("recordedOnly", "/recorded-only", {
    error: [ApiError, PlanExpiredError],
    query: Schema.Struct({ monday: Schema.optional(Day), only: Schema.optional(WeekScope) }),
    success: HttpApiSchema.StreamUint8Array({ contentType: "application/x-ndjson" })
  }))
  .prefix("/api/week")
{}

export class RowsGroup extends HttpApiGroup.make("rows")
  .add(HttpApiEndpoint.post("describe", "/describe", {
    error: [ApiError, PlanExpiredError],
    payload: DescribeRowRequest,
    success: DescribeRowResponse
  }))
  .add(
    HttpApiEndpoint.post("confirm", "/confirm", {
      error: [ApiError, PlanExpiredError, ProposalRejectedError],
      payload: ConfirmPayload,
      success: WriteResult
    })
  )
  .add(
    HttpApiEndpoint.post("manual", "/manual", {
      error: [ApiError, ProposalRejectedError],
      payload: ManualPayload,
      success: WriteResult
    })
  )
  .prefix("/api/rows")
{}

export class ConfigGroup extends HttpApiGroup.make("config")
  .add(HttpApiEndpoint.get("agent", "/agent", { success: SessionAgentSettings }))
  .add(HttpApiEndpoint.post("saveAgent", "/agent", {
    payload: SessionAgentSettings,
    success: SessionAgentSettings,
    error: ApiError
  }))
  .add(
    HttpApiEndpoint.post("standing", "/standing", {
      error: [ApiError, ProposalRejectedError],
      payload: StandingPayload,
      success: StandingResult
    })
  )
  .add(
    HttpApiEndpoint.post("mine", "/mine", {
      error: [ApiError, ProposalRejectedError],
      payload: OwnershipPayload,
      success: OwnershipResult
    })
  )
  .prefix("/api/config")
{}

export class EntriesGroup extends HttpApiGroup.make("entries")
  .add(HttpApiEndpoint.post("update", "/update", {
    error: [ApiError, PlanExpiredError, ProposalRejectedError],
    payload: UpdateSavedEntryRequest,
    success: UpdateSavedEntryResponse
  }))
  .add(HttpApiEndpoint.post("describe", "/describe", {
    error: [ApiError, PlanExpiredError],
    payload: DescribeSavedEntryRequest,
    success: DescribeSavedEntryResponse
  }))
  .prefix("/api/entries")
{}

export class JcfWebApi extends HttpApi.make("JcfWebApi")
  .add(WeekGroup)
  .add(RowsGroup)
  .add(ConfigGroup)
  .add(EntriesGroup)
  .middleware(OwnerSessionAuth)
{}
