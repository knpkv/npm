import * as Schema from "effect/Schema"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"

import { TimelineActorKind, TimelineCursor, TimelineEventDetail, TimelinePage } from "../domain/timeline.js"
import { UtcTimestamp } from "../domain/utcTimestamp.js"
import {
  ForbiddenApiError,
  InvalidRequestApiError,
  NotFoundApiError,
  RequestTimedOutApiError,
  ServiceUnavailableApiError,
  UnauthorizedApiError
} from "./errors.js"
import { SessionCookieAuth } from "./session.js"
import { CanonicalNonNegativeIntegerFromString } from "./wire.js"

const TimelinePageSizeFromString = CanonicalNonNegativeIntegerFromString.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100))
)

/** Hard caller-selected event bound for one Timeline download. */
export const TimelineExportLimitFromString = CanonicalNonNegativeIntegerFromString.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1_000))
)

/** Content types emitted by the bounded Timeline download endpoints. */
export const TimelineExportContentType = Schema.Literals([
  "application/json; charset=utf-8",
  "text/csv; charset=utf-8"
])

/** Security, download, and truncation headers on a Timeline export response. */
export const TimelineExportResponseHeaders = Schema.Struct({
  "cache-control": Schema.Literal("private, no-store"),
  "content-disposition": Schema.Literals([
    "attachment; filename=\"timeline-export.csv\"",
    "attachment; filename=\"timeline-export.json\""
  ]),
  "content-type": TimelineExportContentType,
  "x-content-type-options": Schema.Literal("nosniff"),
  "x-timeline-export-count": CanonicalNonNegativeIntegerFromString,
  "x-timeline-export-limit": TimelineExportLimitFromString,
  "x-timeline-export-truncated": Schema.Literals(["false", "true"])
}).annotate({ identifier: "TimelineExportResponseHeaders" })

const exportQuery = {
  actor: Schema.optionalKey(TimelineActorKind),
  from: Schema.optionalKey(UtcTimestamp),
  limit: TimelineExportLimitFromString,
  to: Schema.optionalKey(UtcTimestamp)
}

const timelineErrors: readonly [
  typeof InvalidRequestApiError,
  typeof UnauthorizedApiError,
  typeof ForbiddenApiError,
  typeof RequestTimedOutApiError,
  typeof ServiceUnavailableApiError
] = [
  InvalidRequestApiError,
  UnauthorizedApiError,
  ForbiddenApiError,
  RequestTimedOutApiError,
  ServiceUnavailableApiError
]

const page = HttpApiEndpoint.get("page", "/api/v1/timeline", {
  query: {
    actor: Schema.optionalKey(TimelineActorKind),
    beforeEventKey: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024))),
    beforeOccurredAt: Schema.optionalKey(UtcTimestamp),
    from: Schema.optionalKey(UtcTimestamp),
    limit: Schema.optionalKey(TimelinePageSizeFromString),
    to: Schema.optionalKey(UtcTimestamp)
  },
  success: TimelinePage,
  error: timelineErrors
}).middleware(SessionCookieAuth)

const detail = HttpApiEndpoint.get("detail", "/api/v1/timeline/events/:eventKey", {
  params: { eventKey: TimelineCursor.fields.eventKey },
  success: TimelineEventDetail,
  error: [
    InvalidRequestApiError,
    UnauthorizedApiError,
    ForbiddenApiError,
    NotFoundApiError,
    RequestTimedOutApiError,
    ServiceUnavailableApiError
  ]
}).middleware(SessionCookieAuth)

const exportCsv = HttpApiEndpoint.get("exportCsv", "/api/v1/timeline/export.csv", {
  query: exportQuery,
  success: HttpApiSchema.StreamUint8Array({ contentType: "text/csv; charset=utf-8" }),
  error: timelineErrors
}).middleware(SessionCookieAuth)

const exportJson = HttpApiEndpoint.get("exportJson", "/api/v1/timeline/export.json", {
  query: exportQuery,
  success: HttpApiSchema.StreamUint8Array({ contentType: "application/json; charset=utf-8" }),
  error: timelineErrors
}).middleware(SessionCookieAuth)

/** Authenticated, workspace-scoped durable activity Timeline. */
export class TimelineApiGroup extends HttpApiGroup.make("timeline")
  .add(page)
  .add(detail)
  .add(exportCsv)
  .add(exportJson)
{}
