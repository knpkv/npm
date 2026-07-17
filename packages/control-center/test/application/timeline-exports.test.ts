import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema, Stream } from "effect"

import { WorkspaceId } from "../../src/domain/identifiers.js"
import { TimelineEvent } from "../../src/domain/timeline.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import type { TimelineReads } from "../../src/server/api/ApplicationServices.js"
import {
  collectTimelineExport,
  encodeTimelineCsv,
  encodeTimelineJson
} from "../../src/server/application/timelineExports.js"

const workspaceId = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000151")
const occurredAt = Schema.decodeSync(UtcTimestamp)("2026-07-17T12:00:00.000Z")

const event = (eventKey: string, overrides: Partial<TimelineEvent> = {}): TimelineEvent => ({
  eventKey,
  occurredAt,
  actor: { kind: "human", label: "Ada" },
  sourceKind: "action",
  service: null,
  eventType: "authorized",
  title: "Authorized governed action",
  href: null,
  ...overrides
})

const readText = (stream: Stream.Stream<Uint8Array>) => stream.pipe(Stream.decodeText(), Stream.mkString)

const TimelineExportJsonDocument = Schema.fromJsonString(Schema.Struct({
  metadata: Schema.Struct({
    eventCount: Schema.Number,
    eventLimit: Schema.Number,
    truncated: Schema.Boolean
  }),
  events: Schema.Array(TimelineEvent)
}))

describe("Timeline exports", () => {
  it.effect("uses the composite cursor to page same-time events and retain one truncation lookahead", () =>
    Effect.gen(function*() {
      const calls: Array<Parameters<TimelineReads["Service"]["page"]>[0]> = []
      const timeline: TimelineReads["Service"] = {
        page: (input) => {
          calls.push(input)
          if (input.before === null) {
            return Effect.succeed({
              events: [event("system:z"), event("system:y")],
              nextCursor: { eventKey: "system:y", occurredAt }
            })
          }
          return Effect.succeed({ events: [event("system:x")], nextCursor: null })
        }
      }

      const result = yield* collectTimelineExport(timeline, {
        workspaceId,
        actorKind: "human",
        eventLimit: 2,
        from: occurredAt,
        to: occurredAt
      })

      assert.deepStrictEqual(result.events.map(({ eventKey }) => eventKey), ["system:z", "system:y"])
      assert.deepStrictEqual(result.metadata, { eventCount: 2, eventLimit: 2, truncated: true })
      assert.deepStrictEqual(calls.map(({ before, limit }) => ({ before, limit })), [
        { before: null, limit: 3 },
        { before: { eventKey: "system:y", occurredAt }, limit: 1 }
      ])
      assert.isTrue(calls.every((call) =>
        call.workspaceId === workspaceId &&
        call.actorKind === "human" &&
        call.from === occurredAt &&
        call.to === occurredAt
      ))
    }))

  it.effect("CSV-quotes commas, quotes, and line breaks while streaming one row per chunk", () =>
    Effect.gen(function*() {
      const timelineExport = {
        events: [event("audit:1", {
          actor: { kind: "human", label: "Ada, \"Ops\"" },
          title: "Approved, \"ready\"\nnext"
        })],
        metadata: { eventCount: 1, eventLimit: 10, truncated: false }
      }
      const chunks = yield* encodeTimelineCsv(timelineExport).pipe(Stream.runCollect)
      const csv = yield* readText(encodeTimelineCsv(timelineExport))

      assert.strictEqual(chunks.length, 2)
      assert.strictEqual(
        csv,
        "event_key,occurred_at,actor_kind,actor_label,source_kind,service,event_type,title,href\r\n" +
          "\"audit:1\",\"2026-07-17T12:00:00.000Z\",\"human\",\"Ada, \"\"Ops\"\"\",\"action\",\"\",\"authorized\",\"Approved, \"\"ready\"\"\nnext\",\"\"\r\n"
      )
    }))

  it.effect("neutralizes spreadsheet formulas only when they lead a CSV cell", () =>
    Effect.gen(function*() {
      const timelineExport = {
        events: [
          event("=HYPERLINK(\"https://example.test\")", {
            actor: { kind: "human", label: "@SUM(A1:A2)" },
            title: "\t=1+1",
            href: "+cmd"
          }),
          event("audit:2", { title: "Release = ready" })
        ],
        metadata: { eventCount: 2, eventLimit: 10, truncated: false }
      }
      const csv = yield* readText(encodeTimelineCsv(timelineExport))

      assert.include(csv, "\"'=HYPERLINK(\"\"https://example.test\"\")\"")
      assert.include(csv, "\"'@SUM(A1:A2)\"")
      assert.include(csv, "\"'\t=1+1\"")
      assert.include(csv, "\"'+cmd\"")
      assert.include(csv, "\"Release = ready\"")
    }))

  it.effect("JSON-encodes redacted events with explicit truncation metadata", () =>
    Effect.gen(function*() {
      const actorWithSecrets: {
        readonly actorId: string
        readonly kind: "human"
        readonly label: string
        readonly rawPrompt: string
      } = { actorId: "person-secret", kind: "human", label: "Ada", rawPrompt: "prompt-secret" }
      const timelineExport = {
        events: [event("audit:1", { actor: actorWithSecrets, title: "Quoted \"title\"\nnext" })],
        metadata: { eventCount: 1, eventLimit: 1, truncated: true }
      }
      const chunks = yield* encodeTimelineJson(timelineExport).pipe(Stream.runCollect)
      const json = yield* readText(encodeTimelineJson(timelineExport))
      const decoded = Schema.decodeUnknownSync(TimelineExportJsonDocument)(json)
      const decodedEvent = decoded.events[0]
      if (decodedEvent === undefined) return assert.fail("expected one decoded Timeline export event")

      assert.strictEqual(chunks.length, 3)
      assert.deepStrictEqual(decoded.metadata, { eventCount: 1, eventLimit: 1, truncated: true })
      assert.strictEqual(Schema.encodeSync(UtcTimestamp)(decodedEvent.occurredAt), "2026-07-17T12:00:00.000Z")
      assert.strictEqual(decodedEvent.title, "Quoted \"title\"\nnext")
      assert.deepStrictEqual(decodedEvent.actor, { kind: "human", label: "Ada" })
      assert.notInclude(json, "person-secret")
      assert.notInclude(json, "prompt-secret")
    }))
})
