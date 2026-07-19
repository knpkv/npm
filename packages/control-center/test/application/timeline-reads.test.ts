import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"

import { WorkspaceId } from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { presentTimelineEvent, presentTimelineEventDetail } from "../../src/server/application/timelineReads.js"
import type { TimelineRecord } from "../../src/server/persistence/repositories/timelineRepository.js"

const workspaceId = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000151")
const occurredAt = Schema.decodeSync(UtcTimestamp)("2026-07-17T12:00:00.000Z")

const record = (overrides: Partial<TimelineRecord>): TimelineRecord => ({
  eventKey: "audit:event-digest",
  occurredAt,
  actorKind: "human",
  actorId: "private-person-id",
  actorLabel: "Ada",
  eventType: "authorized",
  sourceKind: "action",
  service: null,
  releaseId: null,
  entityId: null,
  actionId: "private-action-id",
  relationshipId: null,
  pluginConnectionId: null,
  agentJobId: null,
  ...overrides
})

describe("Timeline presentation", () => {
  it("uses the Items selection contract for entity-backed events", () => {
    const event = presentTimelineEvent(workspaceId, record({ entityId: "entity-42" }))
    assert.strictEqual(event.href, `/w/${workspaceId}/items/entity-42`)
  })

  it("keeps release-backed events on the release route", () => {
    const event = presentTimelineEvent(
      workspaceId,
      record({
        entityId: "entity-42",
        releaseId: "release-7"
      })
    )
    assert.strictEqual(event.href, `/w/${workspaceId}/releases/release-7`)
  })

  it("expands raw identifiers only in the deliberate owner detail projection", () => {
    const input = record({
      actionId: "action-42",
      actorId: "agent-7",
      agentJobId: "job-9",
      entityId: "entity-42",
      pluginConnectionId: "connection-3",
      releaseId: "release-7",
      relationshipId: "relationship-5"
    })

    const redacted = presentTimelineEvent(workspaceId, input)
    const detail = presentTimelineEventDetail(workspaceId, input)

    assert.notProperty(redacted, "identifiers")
    assert.deepStrictEqual(detail.identifiers, {
      actorId: "agent-7",
      actionId: "action-42",
      relationshipId: "relationship-5",
      pluginConnectionId: "connection-3",
      releaseId: "release-7",
      entityId: "entity-42"
    })
    assert.deepStrictEqual(detail.agentJob, { jobId: "job-9" })
  })
})
