/**
 * The HTTP surface between hub and app, named once so both sides agree.
 *
 * - Hub → app (over the app's unix socket): `/app/*` paths and module routes, with the `x-hub-*` headers.
 * - App → hub (the hub's loopback listener): `/v1/app-services/*`, authenticated with the per-app token.
 *
 * @module
 */
import { Schema } from "effect"
import { Grant } from "./route.js"

export const appPaths = {
  manifest: "/app/manifest",
  health: "/app/health",
  needsYou: "/app/needs-you",
  badge: "/app/badge",
  assets: "/app/assets/"
} satisfies Record<string, `/${string}`>

/** Headers the hub sets on a proxied request and strips from every inbound one. */
export const hubHeaders = {
  caller: "x-hub-caller",
  requestId: "x-hub-request-id",
  grant: "x-hub-grant",
  app: "x-hub-app"
}

/** Paths the hub serves to apps on its loopback listener. */
export const appServicePaths = {
  host: "/v1/app-services/host",
  fleetRead: "/v1/app-services/fleet-read",
  jobs: "/v1/app-services/jobs",
  relay: "/v1/app-services/relay"
}

export const HostInfo = Schema.Struct({
  host: Schema.String,
  isHub: Schema.Boolean,
  hosts: Schema.Array(Schema.String)
})
export interface HostInfo extends Schema.Schema.Type<typeof HostInfo> {}

/** Fleet reads the hub already fans out to its peers; each answers the hub's own JSON for that read. */
export const FleetReadKind = Schema.Literals(["usage", "limits"])
export type FleetReadKind = typeof FleetReadKind.Type

export const FleetReadRequest = Schema.Struct({
  read: FleetReadKind,
  query: Schema.Record(Schema.String, Schema.String)
})
export interface FleetReadRequest extends Schema.Schema.Type<typeof FleetReadRequest> {}

/** A Fleet job submitted for the caller the grant names. The payload is checked by the hub's job schema. */
export const JobSubmission = Schema.Struct({ grant: Grant, payload: Schema.Json })
export interface JobSubmission extends Schema.Schema.Type<typeof JobSubmission> {}

export const JobAccepted = Schema.Struct({ jobId: Schema.String, status: Schema.String })
export interface JobAccepted extends Schema.Schema.Type<typeof JobAccepted> {}

/** A Relay post as the app, or as the caller when a grant is given. */
export const RelayPost = Schema.Struct({
  grant: Schema.NullOr(Grant),
  kind: Schema.Literals(["status", "blocker"]),
  text: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_000))
})
export interface RelayPost extends Schema.Schema.Type<typeof RelayPost> {}

/** Why the hub refused an app-service call. */
export const AppServiceRefusal = Schema.Struct({
  code: Schema.Literals([
    "unauthorized",
    "undeclared",
    "grant_unknown",
    "grant_expired",
    "grant_used",
    "grant_app_mismatch",
    "rejected",
    "unavailable"
  ])
})
export interface AppServiceRefusal extends Schema.Schema.Type<typeof AppServiceRefusal> {}
