import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

import type { WorkspaceId } from "../../domain/identifiers.js"
import type { TimelineActorKind, TimelineCursor, TimelineEvent, TimelinePage } from "../../domain/timeline.js"
import type { UtcTimestamp } from "../../domain/utcTimestamp.js"
import type { ApplicationServiceUnavailable, TimelineReads } from "../api/ApplicationServices.js"

const TIMELINE_EXPORT_PAGE_SIZE = 100

/** Caller-selected filters and hard event cap for one default-redacted export. */
export interface TimelineExportInput {
  readonly actorKind: TimelineActorKind | null
  readonly eventLimit: number
  readonly from: UtcTimestamp | null
  readonly to: UtcTimestamp | null
  readonly workspaceId: WorkspaceId
}

/** Bounded material shared by the CSV and JSON encoders. */
export interface TimelineExport {
  readonly events: ReadonlyArray<TimelineEvent>
  readonly metadata: {
    readonly eventCount: number
    readonly eventLimit: number
    readonly truncated: boolean
  }
}

/**
 * Read through the public Timeline application seam using its stable composite
 * cursor. One extra event is retained only long enough to report truncation.
 */
export const collectTimelineExport = Effect.fn("TimelineExports.collect")(function*(
  timeline: TimelineReads["Service"],
  input: TimelineExportInput
): Effect.fn.Return<TimelineExport, ApplicationServiceUnavailable> {
  const collected: Array<TimelineEvent> = []
  let before: TimelineCursor | null = null

  while (collected.length < input.eventLimit + 1) {
    const pageLimit = Math.min(TIMELINE_EXPORT_PAGE_SIZE, input.eventLimit + 1 - collected.length)
    const page: TimelinePage = yield* timeline.page({
      workspaceId: input.workspaceId,
      actorKind: input.actorKind,
      before,
      from: input.from,
      limit: pageLimit,
      to: input.to
    })
    for (const event of page.events.slice(0, pageLimit)) collected.push(event)
    if (page.nextCursor === null || page.events.length === 0) break
    before = page.nextCursor
  }

  const events = collected.slice(0, input.eventLimit)
  return {
    events,
    metadata: {
      eventCount: events.length,
      eventLimit: input.eventLimit,
      truncated: collected.length > input.eventLimit
    }
  }
})

const spreadsheetFormulaPrefix = /^[=+\-@\t\r\n]/u

const csvCell = (value: string | null): string => {
  const text = value ?? ""
  const inertText = spreadsheetFormulaPrefix.test(text) ? `'${text}` : text
  return `"${inertText.replaceAll("\"", "\"\"")}"`
}

const csvRow = (event: TimelineEvent): string =>
  [
    event.eventKey,
    DateTime.formatIso(event.occurredAt),
    event.actor.kind,
    event.actor.label,
    event.sourceKind,
    event.service,
    event.eventType,
    event.title,
    event.href
  ].map(csvCell).join(",") + "\r\n"

const jsonEvent = (event: TimelineEvent) => ({
  eventKey: event.eventKey,
  occurredAt: DateTime.formatIso(event.occurredAt),
  actor: { kind: event.actor.kind, label: event.actor.label },
  sourceKind: event.sourceKind,
  service: event.service,
  eventType: event.eventType,
  title: event.title,
  href: event.href
})

/** Encode a standards-compatible CSV document one bounded row per byte chunk. */
export const encodeTimelineCsv = (timelineExport: TimelineExport): Stream.Stream<Uint8Array> =>
  Stream.fromIterable([
    "event_key,occurred_at,actor_kind,actor_label,source_kind,service,event_type,title,href\r\n",
    ...timelineExport.events.map(csvRow)
  ]).pipe(Stream.encodeText)

/** Encode a JSON object with explicit truncation metadata and bounded event chunks. */
export const encodeTimelineJson = (timelineExport: TimelineExport): Stream.Stream<Uint8Array> => {
  const eventChunks = timelineExport.events.map((event, index) =>
    `${index === 0 ? "" : ","}${JSON.stringify(jsonEvent(event))}`
  )
  return Stream.fromIterable([
    `{"metadata":${JSON.stringify(timelineExport.metadata)},"events":[`,
    ...eventChunks,
    "]}\n"
  ]).pipe(Stream.encodeText)
}
