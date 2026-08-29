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
import type { ClockifyApiClientContract, TimeEntry } from "@knpkv/clockify-api-client"
import { ClockifyApiClient } from "@knpkv/clockify-api-client"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as Redacted from "effect/Redacted"
import { TestClock } from "effect/testing"
import { Command } from "effect/unstable/cli"
import { statusCmd } from "../src/cli/timer/status.js"
import { ClockifyAuth } from "../src/services/ClockifyAuth.js"
import type { StateWriterContract, TimerStateFile } from "../src/services/StateWriter.js"
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
const baseClient: ClockifyApiClientContract = {
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

const stateWriterFor = (capture: Capture): StateWriterContract => ({
  read: Effect.succeed(activeState),
  write: (state: TimerStateFile) =>
    Effect.sync(() => {
      capture.written.push(state)
    }),
  clear: Effect.sync(() => {
    capture.cleared = true
  })
})

const layersFor = (
  client: ClockifyApiClientContract,
  capture: Capture,
  stateWriter: StateWriterContract = stateWriterFor(capture)
) =>
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
    Layer.succeed(StateWriter, stateWriter),
    NodeServices.layer
  )

interface RunOverrides {
  readonly fileSystem?: FileSystem.FileSystem
  readonly stateWriter?: StateWriterContract
}

const run = (
  client: ClockifyApiClientContract,
  capture: Capture,
  args: ReadonlyArray<string> = [],
  overrides: RunOverrides = {}
) => {
  const command = Command.runWith(statusCmd, { version: "0.0.0-test" })(args)
  const withFileSystem = overrides.fileSystem === undefined
    ? command
    : command.pipe(Effect.provideService(FileSystem.FileSystem, overrides.fileSystem))
  return withFileSystem.pipe(
    // Test runner boundary: every command service is composed above and supplied once.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(layersFor(client, capture, overrides.stateWriter)),
    Effect.exit
  )
}

const fileSystemFailure = (method: string, tag: PlatformError.SystemErrorTag) =>
  new PlatformError.PlatformError(
    new PlatformError.SystemError({
      _tag: tag,
      module: "FileSystem",
      method,
      description: `${method} test failure`
    })
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

  it.effect("skips a second nvim poll while the completion stamp is fresh", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "jcf-poll-stamp-" })
      const stampPath = `${root}/poll.stamp`
      yield* fs.writeFileString(stampPath, "0")

      const capture = makeCapture()
      let calls = 0
      const client = {
        ...baseClient,
        getRunningTimer: () =>
          Effect.sync(() => {
            calls += 1
            return null
          })
      }
      const exit = yield* run(client, capture, [
        "--nvim-poll-stamp",
        stampPath,
        "--nvim-poll-interval-ms",
        "30000"
      ])

      expect(exit._tag).toBe("Success")
      expect(calls).toBe(0)
      expect(capture.cleared).toBe(false)
    }).pipe(
      Effect.scoped,
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(NodeServices.layer)
    ))

  it.effect("keeps sub-second polling intervals precise across a second boundary", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "jcf-poll-millisecond-stamp-" })
      const stampPath = `${root}/poll.stamp`
      yield* fs.writeFileString(stampPath, "1000999")
      yield* TestClock.setTime(1_001_001)

      const capture = makeCapture()
      let calls = 0
      const client = {
        ...baseClient,
        getRunningTimer: () =>
          Effect.sync(() => {
            calls += 1
            return null
          })
      }
      const args = ["--nvim-poll-stamp", stampPath, "--nvim-poll-interval-ms", "500"]

      const suppressed = yield* run(client, capture, args)
      expect(suppressed._tag).toBe("Success")
      expect(calls).toBe(0)

      yield* TestClock.setTime(1_001_499)
      const afterInterval = yield* run(client, capture, args)
      expect(afterInterval._tag).toBe("Success")
      expect(calls).toBe(1)
      expect(Number(yield* fs.readFileString(stampPath))).toBe(1_001_499)
    }).pipe(
      Effect.scoped,
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(NodeServices.layer)
    ))

  it.effect("runs a missing nvim poll stamp once and persists it", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "jcf-poll-complete-" })
      const stampPath = `${root}/poll.stamp`

      const capture = makeCapture()
      let calls = 0
      const client = {
        ...baseClient,
        getRunningTimer: () =>
          Effect.sync(() => {
            calls += 1
            return null
          })
      }
      const exit = yield* run(
        client,
        capture,
        [
          "--nvim-poll-stamp",
          stampPath,
          "--nvim-poll-interval-ms",
          "30000"
        ]
      )

      expect(exit._tag).toBe("Success")
      expect(calls).toBe(1)
      expect(capture.cleared).toBe(true)
      expect(Number(yield* fs.readFileString(stampPath))).toBe(0)

      const secondExit = yield* run(client, capture, [
        "--nvim-poll-stamp",
        stampPath,
        "--nvim-poll-interval-ms",
        "30000"
      ])
      expect(secondExit._tag).toBe("Success")
      expect(calls).toBe(1)
    }).pipe(
      Effect.scoped,
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(NodeServices.layer)
    ))

  it.effect("fails before reconciliation when the nvim poll stamp cannot be read", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      let calls = 0
      const capture = makeCapture()
      const exit = yield* run(
        {
          ...baseClient,
          getRunningTimer: () =>
            Effect.sync(() => {
              calls += 1
              return null
            })
        },
        capture,
        [
          "--nvim-poll-stamp",
          "/poll.stamp",
          "--nvim-poll-interval-ms",
          "30000"
        ],
        {
          fileSystem: {
            ...fs,
            readFileString: () => Effect.fail(fileSystemFailure("readFileString", "PermissionDenied"))
          }
        }
      )

      expect(exit._tag).toBe("Failure")
      expect(calls).toBe(0)
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(NodeServices.layer)
    ))

  it.effect("reports a completion-stamp write failure after reconciliation", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      let calls = 0
      const capture = makeCapture()
      const exit = yield* run(
        {
          ...baseClient,
          getRunningTimer: () =>
            Effect.sync(() => {
              calls += 1
              return null
            })
        },
        capture,
        [
          "--nvim-poll-stamp",
          "/poll.stamp",
          "--nvim-poll-interval-ms",
          "30000"
        ],
        {
          fileSystem: {
            ...fs,
            readFileString: () => Effect.fail(fileSystemFailure("readFileString", "NotFound")),
            writeFileString: () => Effect.fail(fileSystemFailure("writeFileString", "PermissionDenied"))
          }
        }
      )

      expect(exit._tag).toBe("Failure")
      expect(calls).toBe(1)
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(NodeServices.layer)
    ))

  it.effect("rate-bounds a failed managed attempt without changing unmanaged failures", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "jcf-poll-failed-" })
      const stampPath = `${root}/poll.stamp`
      const args = ["--nvim-poll-stamp", stampPath, "--nvim-poll-interval-ms", "30000"]
      const capture = makeCapture()

      const failed = yield* run(baseClient, capture, args, {
        stateWriter: {
          ...stateWriterFor(capture),
          read: Effect.die("state read failed")
        }
      })
      expect(failed._tag).toBe("Failure")
      expect(yield* fs.exists(stampPath)).toBe(true)

      const suppressedRetry = yield* run(baseClient, capture, args, {
        stateWriter: {
          ...stateWriterFor(capture),
          read: Effect.die("must be skipped while the attempt stamp is fresh")
        }
      })
      expect(suppressedRetry._tag).toBe("Success")

      const unmanagedFailure = yield* run(baseClient, capture, [], {
        stateWriter: {
          ...stateWriterFor(capture),
          read: Effect.die("unmanaged state read failed")
        }
      })
      expect(unmanagedFailure._tag).toBe("Failure")
    }).pipe(
      Effect.scoped,
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(NodeServices.layer)
    ))

  it.effect("reports invalid managed-poll flags in the typed failure channel", () =>
    Effect.gen(function*() {
      const exit = yield* run(baseClient, makeCapture(), ["--nvim-poll-stamp", "/poll.stamp"])

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(exit.cause.reasons.map((reason) => reason._tag)).toEqual(["Fail"])
      }
    }))
})
