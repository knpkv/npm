/** Client-safe contracts. IDs and metadata cross only the authenticated owner API, never public telemetry. */
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/http-api"
import { PlanState } from "./plan.js"
import { StackState } from "./schema.js"

export { PlanRow, PlanSource, PlanState, PublishedPlan } from "./plan.js"

/** Random, process-scoped identity; contains no encoded provider locator. Not persisted by the server. */
export const StackId = Schema.String.check(Schema.isUUID())
export type StackId = typeof StackId.Type

export const SourceFailureReason = Schema.Literals([
  "io",
  "invalid-state",
  "invalid-lockfile",
  "unsupported-version",
  "limit",
  "outside-root",
  "invalid-config",
  "authentication",
  "denied",
  "not-found",
  "provider",
  "invalid-response",
  "invalid-source"
])

export const DiscoveryIssue = Schema.Struct({
  source: Schema.Literals(["local", "s3"]),
  reason: SourceFailureReason
})
export type DiscoveryIssue = typeof DiscoveryIssue.Type

export const StackSummary = Schema.Struct({
  id: StackId,
  app: Schema.NonEmptyString,
  stage: Schema.NonEmptyString,
  backend: Schema.Literals(["local", "s3"]),
  alchemyVersion: Schema.NullOr(Schema.String),
  lastDeploy: Schema.NullOr(Schema.String),
  resourceCount: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
})
export type StackSummary = typeof StackSummary.Type

export const StackList = Schema.Struct({ stacks: Schema.Array(StackSummary), issues: Schema.Array(DiscoveryIssue) })
export type StackList = typeof StackList.Type
export const StackDetail = Schema.Struct({ id: StackId, state: StackState })
export type StackDetail = typeof StackDetail.Type

export class CatalogReadError extends Schema.TaggedError<CatalogReadError>()("CatalogReadError", {
  reason: SourceFailureReason
}, { httpApiStatus: 503 }) {}

export class StackNotFound extends Schema.TaggedError<StackNotFound>()("StackNotFound", {}, { httpApiStatus: 404 }) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}, { httpApiStatus: 401 }) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {}, { httpApiStatus: 403 }) {}

/** The server resolves its listener-specific cookie name at request time. */
export class OwnerAuth extends HttpApiMiddleware.Service<OwnerAuth>()("@knpkv/alchemy-console/OwnerAuth", {
  error: [Unauthorized, Forbidden]
}) {}

const stacks = HttpApiGroup.make("stacks")
  .add(HttpApiEndpoint.get("list", "/stacks", { success: StackList, error: CatalogReadError }))
  .add(HttpApiEndpoint.get("get", "/stacks/:id", {
    params: Schema.Struct({ id: StackId }),
    success: StackDetail,
    error: [StackNotFound, CatalogReadError]
  }))
  .add(HttpApiEndpoint.get("plan", "/stacks/:id/plan", {
    params: Schema.Struct({ id: StackId }),
    success: PlanState,
    error: [StackNotFound, CatalogReadError]
  }))
  .prefix("/api")

export class AlchemyConsoleApi extends HttpApi.make("AlchemyConsoleApi").add(stacks).middleware(OwnerAuth) {}
