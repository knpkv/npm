import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import type { WorkspaceId } from "../../domain/identifiers.js"
import type { TimelineEvent, TimelineEventDetail, TimelinePage } from "../../domain/timeline.js"
import {
  ApplicationResourceNotFound,
  ApplicationServiceUnavailable,
  TimelineReads
} from "../api/ApplicationServices.js"
import { Persistence } from "../persistence/Persistence.js"
import type { TimelineRecord } from "../persistence/repositories/timelineRepository.js"

const unavailable = (): ApplicationServiceUnavailable => new ApplicationServiceUnavailable({ retryAt: null })

const actorLabel = (record: TimelineRecord): string => {
  const persisted = record.actorLabel?.trim()
  if (persisted !== undefined && persisted.length > 0) return persisted
  switch (record.actorKind) {
    case "agent":
      return "Release agent"
    case "human":
      return "Collaborator"
    case "plugin":
      return "Connected service"
    case "system":
      return "Control Center"
  }
}

const sentenceCase = (value: string): string => {
  const words = value.replaceAll("-", " ")
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}

const eventTitle = (record: TimelineRecord): string => {
  switch (record.sourceKind) {
    case "action":
      return `${sentenceCase(record.eventType)} governed action`
    case "plugin-sync":
      return `Synchronized ${actorLabel(record)}`
    case "relationship":
      return `${sentenceCase(record.eventType)} delivery relationship`
    case "system":
      return sentenceCase(record.eventType)
  }
}

const eventHref = (workspaceId: WorkspaceId, record: TimelineRecord): string | null => {
  if (record.releaseId !== null) return `/w/${workspaceId}/releases/${record.releaseId}`
  if (record.entityId !== null) return `/w/${workspaceId}/items?object=${record.entityId}#item-details`
  if (record.sourceKind === "plugin-sync") return "/services"
  return null
}

/** Present one default-redacted durable record for the Timeline client. */
export const presentTimelineEvent = (workspaceId: WorkspaceId, record: TimelineRecord): TimelineEvent => ({
  eventKey: record.eventKey,
  occurredAt: record.occurredAt,
  actor: { kind: record.actorKind, label: actorLabel(record) },
  sourceKind: record.sourceKind,
  service: record.service,
  eventType: record.eventType,
  title: eventTitle(record),
  href: eventHref(workspaceId, record)
})

/** Expand one exact Timeline event with owner-visible identifiers and agent attribution. */
export const presentTimelineEventDetail = (
  workspaceId: WorkspaceId,
  record: TimelineRecord
): TimelineEventDetail => ({
  event: presentTimelineEvent(workspaceId, record),
  identifiers: {
    actorId: record.actorId,
    actionId: record.actionId,
    relationshipId: record.relationshipId,
    pluginConnectionId: record.pluginConnectionId,
    releaseId: record.releaseId,
    entityId: record.entityId
  },
  agentJob: record.agentJobId === null ? null : { jobId: record.agentJobId }
})

/** Construct the durable activity projection from bounded persistence reads. */
export const makeTimelineReads = Effect.gen(function*() {
  const persistence = yield* Persistence
  return TimelineReads.of({
    page: Effect.fn("TimelineReads.page")(function*(input) {
      const records = yield* persistence.timeline.page(input).pipe(Effect.mapError(() => unavailable()))
      const visible = records.slice(0, input.limit)
      const last = visible.at(-1)
      return {
        events: visible.map((record) => presentTimelineEvent(input.workspaceId, record)),
        nextCursor: records.length > input.limit && last !== undefined
          ? { eventKey: last.eventKey, occurredAt: last.occurredAt }
          : null
      } satisfies TimelinePage
    }),
    detail: Effect.fn("TimelineReads.detail")(function*(input) {
      const record = yield* persistence.timeline.detail(input).pipe(Effect.mapError(() => unavailable()))
      if (record === null) return yield* new ApplicationResourceNotFound()
      return presentTimelineEventDetail(input.workspaceId, record)
    })
  })
})

/** Live default-redacted Timeline projection. */
export const timelineReadsLayer = Layer.effect(TimelineReads, makeTimelineReads)
