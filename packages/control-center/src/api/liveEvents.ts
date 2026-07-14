import * as Schema from "effect/Schema"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"

import { PortfolioInvalidatedEventV1 } from "../domain/domainEvent.js"
import { EventCursor } from "../domain/identifiers.js"
import { UtcTimestamp } from "../domain/utcTimestamp.js"
import {
  ForbiddenApiError,
  InvalidRequestApiError,
  RateLimitedApiError,
  RequestTimedOutApiError,
  ServiceUnavailableApiError,
  UnauthorizedApiError
} from "./errors.js"
import { PortfolioSnapshot } from "./portfolio.js"
import { SessionCookieAuth } from "./session.js"
import { CanonicalNonNegativeIntegerFromString } from "./wire.js"

/** URL/header representation of a nonnegative workspace event cursor. */
export const EventCursorFromString = CanonicalNonNegativeIntegerFromString.pipe(Schema.decodeTo(EventCursor))

/** Replay boundary telling a client to replace local state with an authoritative snapshot. */
export const StreamResetRequired = Schema.Struct({
  reason: Schema.Literals(["retention", "cursor-ahead", "gap", "replay-budget"]),
  requestedCursor: EventCursor,
  headCursor: EventCursor,
  prunedThroughCursor: EventCursor
}).annotate({ identifier: "StreamResetRequired" })

/** Decoded reset instruction carried by the live event stream. */
export type StreamResetRequired = typeof StreamResetRequired.Type

/** Keepalive payload that reports the latest durable cursor without advancing EventSource state. */
export const StreamHeartbeat = Schema.Struct({
  eventCursor: EventCursor,
  sentAt: UtcTimestamp
}).annotate({ identifier: "StreamHeartbeat" })

/** Decoded keepalive payload carried by the live event stream. */
export type StreamHeartbeat = typeof StreamHeartbeat.Type

/** Authoritative portfolio replacement emitted first and after replay reset. */
export const PortfolioSnapshotLiveEvent = Schema.Struct({
  id: EventCursorFromString,
  event: Schema.Literal("portfolio.snapshot"),
  data: Schema.fromJsonString(PortfolioSnapshot)
}).annotate({ identifier: "PortfolioSnapshotLiveEvent" })

/** Decoded authoritative portfolio stream event. */
export type PortfolioSnapshotLiveEvent = typeof PortfolioSnapshotLiveEvent.Type

/** Durable notification that a browser should refresh its portfolio projection. */
export const PortfolioInvalidatedLiveEvent = Schema.Struct({
  id: EventCursorFromString,
  event: Schema.Literal("portfolio.invalidated"),
  data: Schema.fromJsonString(PortfolioInvalidatedEventV1)
}).annotate({ identifier: "PortfolioInvalidatedLiveEvent" })

/** Decoded portfolio invalidation stream event. */
export type PortfolioInvalidatedLiveEvent = typeof PortfolioInvalidatedLiveEvent.Type

/** Replay-gap instruction; it deliberately has no SSE ID so it cannot advance resume state. */
export const StreamResetRequiredLiveEvent = Schema.Struct({
  id: Schema.optionalKey(Schema.Never),
  event: Schema.Literal("stream.reset-required"),
  data: Schema.fromJsonString(StreamResetRequired)
}).annotate({ identifier: "StreamResetRequiredLiveEvent" })

/** Decoded replay-gap stream event. */
export type StreamResetRequiredLiveEvent = typeof StreamResetRequiredLiveEvent.Type

/** Keepalive event; it deliberately has no SSE ID so it cannot advance resume state. */
export const StreamHeartbeatLiveEvent = Schema.Struct({
  id: Schema.optionalKey(Schema.Never),
  event: Schema.Literal("stream.heartbeat"),
  data: Schema.fromJsonString(StreamHeartbeat)
}).annotate({ identifier: "StreamHeartbeatLiveEvent" })

/** Decoded keepalive stream event. */
export type StreamHeartbeatLiveEvent = typeof StreamHeartbeatLiveEvent.Type

/** Closed browser-safe union emitted by the authenticated live event stream. */
export const ControlCenterLiveEvent = Schema.Union([
  PortfolioSnapshotLiveEvent,
  PortfolioInvalidatedLiveEvent,
  StreamResetRequiredLiveEvent,
  StreamHeartbeatLiveEvent
]).annotate({ identifier: "ControlCenterLiveEvent" })

/** Decoded browser-safe live event. */
export type ControlCenterLiveEvent = typeof ControlCenterLiveEvent.Type

const stream = HttpApiEndpoint.get("stream", "/api/v1/events", {
  query: {
    after: Schema.optionalKey(EventCursorFromString)
  },
  headers: {
    "last-event-id": Schema.optionalKey(EventCursorFromString)
  },
  success: HttpApiSchema.StreamSse({ events: ControlCenterLiveEvent }),
  error: [
    InvalidRequestApiError,
    UnauthorizedApiError,
    ForbiddenApiError,
    RateLimitedApiError,
    RequestTimedOutApiError,
    ServiceUnavailableApiError
  ]
}).middleware(SessionCookieAuth)

/** Authenticated resumable stream of workspace-local Control Center events. */
export class LiveEventsApiGroup extends HttpApiGroup.make("liveEvents").add(stream) {}
