import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { renderDayCalendar } from "../../src/cli/calendar.js"

const grid = (lines: ReadonlyArray<string>): ReadonlyArray<string> => lines.filter((line) => /^ {2}\d{2}h/u.test(line))

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone

const spring = renderDayCalendar({
  day: "2026-03-08",
  rows: [{
    ticketKey: "PROJ-1",
    spans: [{
      startMs: Date.parse("2026-03-08T01:50:00-05:00"),
      endMs: Date.parse("2026-03-08T03:10:00-04:00")
    }]
  }]
})

const ordinary = renderDayCalendar({
  day: "2026-03-07",
  rows: [{
    ticketKey: "PROJ-1",
    spans: [{
      startMs: Date.parse("2026-03-07T01:50:00-05:00"),
      endMs: Date.parse("2026-03-07T03:10:00-05:00")
    }]
  }]
})

const lordHowe = renderDayCalendar({
  day: "2026-04-05",
  rows: [
    {
      ticketKey: "PROJ-1",
      spans: [{
        startMs: Date.parse("2026-04-05T01:35:00+11:00"),
        endMs: Date.parse("2026-04-05T01:45:00+11:00")
      }]
    },
    {
      ticketKey: "PROJ-2",
      spans: [{
        startMs: Date.parse("2026-04-05T01:35:00+10:30"),
        endMs: Date.parse("2026-04-05T01:45:00+10:30")
      }]
    }
  ]
})

NodeRuntime.runMain(
  Console.log(JSON.stringify({ zone, spring: grid(spring), ordinary: grid(ordinary), lordHowe: grid(lordHowe) })).pipe(
    Effect.asVoid
  )
)
