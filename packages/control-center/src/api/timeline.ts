import * as Schema from "effect/Schema"
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

import { TimelineActorKind, TimelinePage } from "../domain/timeline.js"
import { UtcTimestamp } from "../domain/utcTimestamp.js"
import {
  ForbiddenApiError,
  InvalidRequestApiError,
  RequestTimedOutApiError,
  ServiceUnavailableApiError,
  UnauthorizedApiError
} from "./errors.js"
import { SessionCookieAuth } from "./session.js"
import { CanonicalNonNegativeIntegerFromString } from "./wire.js"

const TimelinePageSizeFromString = CanonicalNonNegativeIntegerFromString.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100))
)

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
  error: [
    InvalidRequestApiError,
    UnauthorizedApiError,
    ForbiddenApiError,
    RequestTimedOutApiError,
    ServiceUnavailableApiError
  ]
}).middleware(SessionCookieAuth)

/** Authenticated, workspace-scoped durable activity Timeline. */
export class TimelineApiGroup extends HttpApiGroup.make("timeline").add(page) {}
