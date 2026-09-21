import { expect, it } from "@effect/vitest"
import { ReconcileService } from "@knpkv/jira-clockify"
import { FAKE_HOME, makeFakeHeadless } from "@knpkv/jira-clockify/testing.js"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { logManualEntry } from "../src/server/Confirm.js"

// This file runs in its own Europe/Berlin worker, never by changing another suite's process timezone.
// @effect-diagnostics strictEffectProvide:off
const exercise = (day: string, startClock: string, start: Date, endIso: string, offsetChanged: boolean) =>
  Effect.gen(function*() {
    const startMs = start.getTime()
    const endMs = startMs + 3_600_000
    const end = new Date(endMs)
    expect(start.toISOString()).toBe(`${day}T00:30:00.000Z`)
    expect(end.toISOString()).toBe(endIso)
    expect(start.getTimezoneOffset() !== end.getTimezoneOffset()).toBe(offsetChanged)

    const fake = makeFakeHeadless({
      config: { sessionRoots: [`${FAKE_HOME}/dev/work`] },
      transcripts: {}
    })
    const result = yield* Effect.gen(function*() {
      yield* TestClock.setTime(endMs)
      const reconcile = yield* ReconcileService.ReconcileService
      return yield* logManualEntry({
        request: {
          day,
          note: undefined,
          seconds: 3600,
          startClock,
          targets: { clockify: true, jira: true },
          ticketKey: "PROJ-42"
        },
        service: reconcile,
        summaryOf: () => Effect.succeed(null)
      })
    }).pipe(Effect.provide(fake.layer))
    expect(result.clockify).toEqual({ _tag: "Written", seconds: 3600 })
    expect(result.jira).toEqual({ _tag: "Written", seconds: 3600 })
    expect(fake.world.createdClockifyEntries[0]).toMatchObject({
      start: start.toISOString(),
      end: endIso
    })
    expect(new Date(fake.world.jiraWorklogs[0]?.started ?? "").getTime()).toBe(startMs)
    expect(fake.world.jiraWorklogs[0]?.timeSpentSeconds).toBe(3600)
  })

it.effect("crosses the Berlin spring-forward gap in exactly 3600 elapsed seconds", () =>
  exercise("2026-03-29", "01:30", new Date(2026, 2, 29, 1, 30), "2026-03-29T01:30:00.000Z", true))

it.effect("keeps 3600 elapsed seconds on an ordinary Berlin day", () =>
  exercise("2026-03-28", "01:30", new Date(2026, 2, 28, 1, 30), "2026-03-28T01:30:00.000Z", false))

it.effect("crosses the repeated Berlin autumn hour in exactly 3600 elapsed seconds", () =>
  exercise("2026-10-25", "02:30", new Date(2026, 9, 25, 2, 30), "2026-10-25T01:30:00.000Z", true))
