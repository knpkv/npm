/**
 * `jcf timer status` reconciliation invariant.
 *
 * `status` is the only command that deletes local timer state without the user
 * asking, and the nvim statusline runs it on a timer — so a wrong "the API says
 * there is no timer" reading silently drops a running timer's ticket, start
 * time and Clockify entry id. The rule the command encodes is narrow: clear
 * only when Clockify actually answered *and* answered "nothing running". An
 * unreachable API — including one that merely exceeds the per-call bound — must
 * leave the state file alone.
 *
 * Scope note: these tests pin that invariant, not the pipe ordering that
 * implements it. Whether `Effect.timeout` sits inside or outside the
 * `apiReachable` tap is only observable when the lookup and the deadline
 * resolve on the same instant — in every other interleaving the tap is either
 * reached normally or interrupted along with the call, including a lookup that
 * would have answered late, since the deadline resolves the race first and
 * cancels it. That tie has no deterministic winner to assert on, so the
 * ordering is held by the comment in `status.ts` and by these tests failing if
 * the reachability gate itself is removed, rather than by a fixture.
 */
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import type { ClockifyApiClientShape, TimeEntry } from "@knpkv/clockify-api-client"
import { ClockifyApiClient } from "@knpkv/clockify-api-client"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { TestClock } from "effect/testing"
import { Command } from "effect/unstable/cli"
import { statusCmd } from "../src/cli/timer/status.js"
import { ClockifyAuth } from "../src/services/ClockifyAuth.js"
import type { TimerStateFile } from "../src/services/StateWriter.js"
import { StateWriter } from "../src/services/StateWriter.js"

const WORKSPACE_ID = "ws-1"
const USER_ID = "user-1"

// `clockifyEntryId: null` keeps the run inside the reconciliation branch: the
// display section below it makes further Clockify calls that this test is not
// about, and each would need its own clock advance.
const activeState: TimerStateFile = {
  active: true,
  ticketKey: "PROJ-123",
  summary: "Fix the widget",
  project: null,
  startedAt: "2025-01-01T10:00:00.000Z",
  startedAt_unix: 1735725600,
  elapsed: 0,
  clockifyEntryId: null
}

const runningEntry: TimeEntry = {
  id: "entry-1",
  description: "[PROJ-123] Fix the widget",
  billable: true,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  timeInterval: { start: activeState.startedAt ?? "" },
  tagIds: [],
  type: "REGULAR",
  isLocked: false
}

const unreachable = (name: string) => Effect.die(new Error(`${name} must not be called by \`timer status\``))

// Only the members `status` is allowed to reach are implemented; everything
// else defects, so a future change that widens the command's API surface fails
// here loudly instead of silently passing.
const baseClient: ClockifyApiClientShape = {
  getUser: () => unreachable("getUser"),
  getWorkspaces: () => unreachable("getWorkspaces"),
  getProjects: () => Effect.succeed([]),
  getProjectByName: () => unreachable("getProjectByName"),
  createTimeEntry: () => unreachable("createTimeEntry"),
  stopTimer: () => unreachable("stopTimer"),
  getTimeEntries: () => unreachable("getTimeEntries"),
  getRunningTimer: () => Effect.succeed(null),
  getTags: () => Effect.succeed([]),
  createTag: () => unreachable("createTag"),
  findOrCreateTag: () => unreachable("findOrCreateTag"),
  getTimeEntry: () => unreachable("getTimeEntry"),
  deleteTimeEntry: () => unreachable("deleteTimeEntry"),
  updateTimeEntry: () => unreachable("updateTimeEntry")
}

interface Capture {
  cleared: boolean
  readonly written: Array<TimerStateFile>
}

const makeCapture = (): Capture => ({ cleared: false, written: [] })

const layersFor = (client: ClockifyApiClientShape, capture: Capture) =>
  Layer.mergeAll(
    Layer.succeed(ClockifyApiClient, client),
    Layer.succeed(ClockifyAuth, {
      getConfig: Effect.succeed({
        apiKey: Redacted.make("key"),
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        baseUrl: "https://api.clockify.me/api"
      }),
      save: () => Effect.void,
      isConfigured: Effect.succeed(true)
    }),
    Layer.succeed(StateWriter, {
      read: Effect.succeed(activeState),
      write: (state: TimerStateFile) =>
        Effect.sync(() => {
          capture.written.push(state)
        }),
      clear: Effect.sync(() => {
        capture.cleared = true
      })
    }),
    NodeServices.layer
  )

const run = (client: ClockifyApiClientShape, capture: Capture) =>
  Command.runWith(statusCmd, { version: "0.0.0-test" })([]).pipe(
    Effect.provide(layersFor(client, capture)),
    Effect.exit
  )

describe("jcf timer status", () => {
  // The regression this pins: bounding the lookup makes a hung request return
  // `null`, which is the same value the API sends for "no timer running". Only
  // the reachability flag separates them, so a timeout must never set it.
  it.effect("leaves state intact when the running-timer lookup times out", () =>
    Effect.gen(function*() {
      const capture = makeCapture()
      // Wait for the lookup to actually be in flight before moving the clock:
      // adjusting past the deadline before it is registered would leave the
      // join hanging on a sleep that never comes due.
      const issued = yield* Deferred.make<void>()
      const stalledLookup = Effect.flatMap(Deferred.succeed(issued, undefined), () => Effect.never)
      const fiber = yield* run({ ...baseClient, getRunningTimer: () => stalledLookup }, capture).pipe(
        Effect.forkChild({ startImmediately: true })
      )

      yield* Deferred.await(issued)
      yield* TestClock.adjust("11 seconds")
      const exit = yield* Fiber.join(fiber)

      expect(exit._tag).toBe("Success")
      expect(capture.cleared).toBe(false)
      expect(capture.written).toHaveLength(0)
    }))

  it.effect("clears state when the API confirms no timer is running", () =>
    Effect.gen(function*() {
      const capture = makeCapture()

      const exit = yield* run({ ...baseClient, getRunningTimer: () => Effect.succeed(null) }, capture)

      expect(exit._tag).toBe("Success")
      expect(capture.cleared).toBe(true)
    }))

  it.effect("refreshes state when the API confirms the timer is still running", () =>
    Effect.gen(function*() {
      const capture = makeCapture()

      const exit = yield* run({ ...baseClient, getRunningTimer: () => Effect.succeed(runningEntry) }, capture)

      expect(exit._tag).toBe("Success")
      expect(capture.cleared).toBe(false)
      expect(capture.written).toHaveLength(1)
      expect(capture.written[0]).toMatchObject({ active: true, ticketKey: "PROJ-123" })
    }))
})
