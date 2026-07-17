import * as Schema from "effect/Schema"

import { UtcTimestamp } from "./utcTimestamp.js"

/** Actor classes that can contribute durable activity to a workspace Timeline. */
export const TimelineActorKind = Schema.Literals(["agent", "human", "plugin", "system"])

/** Decoded Timeline actor class. */
export type TimelineActorKind = typeof TimelineActorKind.Type

/** Durable source streams merged by the Timeline projection. */
export const TimelineSourceKind = Schema.Literals(["action", "plugin-sync", "relationship", "system"])

/** Decoded Timeline source stream. */
export type TimelineSourceKind = typeof TimelineSourceKind.Type

/** Connected provider identity retained when a durable event has provenance. */
export const TimelineService = Schema.Literals(["codecommit", "codepipeline", "jira", "confluence", "clockify"])

/** Decoded connected provider identity. */
export type TimelineService = typeof TimelineService.Type

/** Stable cursor for newest-first Timeline pagination. */
export const TimelineCursor = Schema.Struct({
  eventKey: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024)),
  occurredAt: UtcTimestamp
}).annotate({ identifier: "TimelineCursor" })

/** Decoded stable Timeline cursor. */
export type TimelineCursor = typeof TimelineCursor.Type

/** Default-redacted, human-readable event from one durable workspace source. */
export const TimelineEvent = Schema.Struct({
  eventKey: TimelineCursor.fields.eventKey,
  occurredAt: UtcTimestamp,
  actor: Schema.Struct({
    kind: TimelineActorKind,
    label: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200))
  }),
  sourceKind: TimelineSourceKind,
  service: Schema.NullOr(TimelineService),
  eventType: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
  title: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(300)),
  href: Schema.NullOr(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2_048)))
}).annotate({ identifier: "TimelineEvent" })

/** Decoded Timeline event. */
export type TimelineEvent = typeof TimelineEvent.Type

/** One bounded Timeline page. */
export const TimelinePage = Schema.Struct({
  events: Schema.Array(TimelineEvent).check(
    Schema.makeFilter((events) => events.length <= 100, { expected: "at most 100 Timeline events" })
  ),
  nextCursor: Schema.NullOr(TimelineCursor)
}).annotate({ identifier: "TimelinePage" })

/** Decoded bounded Timeline page. */
export type TimelinePage = typeof TimelinePage.Type
