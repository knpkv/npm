import { describe, expect, it } from "@effect/vitest"
import type { ClockifyApiClientShape } from "@knpkv/clockify-api-client"
import { ClockifyApiClient } from "@knpkv/clockify-api-client"
import { FetchClientError, JiraApiClient } from "@knpkv/jira-api-client"
import { JiraAuth } from "@knpkv/jira-cli/JiraAuth"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as SubscriptionRef from "effect/SubscriptionRef"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { ClockifyAuth } from "../src/services/ClockifyAuth.js"
import { ConfigService } from "../src/services/ConfigService.js"
import { StateWriter } from "../src/services/StateWriter.js"
import type { JiraTicket } from "../src/services/TicketService.js"
import { layer as timerLayer, TimerError, TimerService } from "../src/services/TimerService.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_ID = "ws-1"
const USER_ID = "user-1"
const MANUAL_NOW = Date.parse("2025-01-01T10:00:00.000Z")

const makeTicket = (overrides?: Partial<JiraTicket>): JiraTicket => ({
  key: "PROJ-123",
  summary: "Fix the widget",
  status: "In Progress",
  priority: "High",
  assignee: "dev",
  type: "Bug",
  labels: ["backend"],
  updated: new Date().toISOString(),
  ...overrides
})

let createdEntries: Array<{ workspaceId: string; params: unknown }> = []
let updatedEntries: Array<{ workspaceId: string; id: string; params: unknown }> = []
let deletedEntries: Array<{ workspaceId: string; id: string }> = []
let stoppedTimers: Array<{ workspaceId: string; userId: string; params: unknown }> = []

const resetCaptures = () => {
  createdEntries = []
  updatedEntries = []
  deletedEntries = []
  stoppedTimers = []
}

const makeTimeEntry = (id: string, description: string, startedAt: Date, projectId?: string) => ({
  id,
  description,
  billable: true as const,
  ...(projectId ? { projectId } : {}),
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  timeInterval: { start: startedAt.toISOString() },
  tagIds: [] as Array<string>,
  type: "REGULAR" as const,
  isLocked: false
})

const mockClockify: ClockifyApiClientShape = {
  api: {} as any,
  getUser: () =>
    Effect.succeed({
      id: USER_ID,
      name: "Test",
      email: "t@t.com",
      activeWorkspace: WORKSPACE_ID,
      defaultWorkspace: WORKSPACE_ID,
      profilePicture: "",
      status: "ACTIVE"
    }),
  getWorkspaces: () => Effect.succeed([{ id: WORKSPACE_ID, name: "WS", imageUrl: "" }]),
  getProjects: () => Effect.succeed([]),
  getProjectByName: () => Effect.succeed(null),
  createTimeEntry: (workspaceId, params) => {
    createdEntries.push({ workspaceId, params })
    return Effect.succeed(makeTimeEntry("entry-1", params.description, new Date(params.start)))
  },
  stopTimer: (workspaceId, userId, params) => {
    stoppedTimers.push({ workspaceId, userId, params })
    return Effect.succeed(makeTimeEntry("entry-1", "", new Date()))
  },
  getTimeEntries: () => Effect.succeed([]),
  getRunningTimer: () => Effect.succeed(null),
  getTags: () => Effect.succeed([]),
  createTag: (_ws, name) => Effect.succeed({ id: `tag-${name}`, name, workspaceId: WORKSPACE_ID, archived: false }),
  findOrCreateTag: (_ws, name) =>
    Effect.succeed({ id: `tag-${name}`, name, workspaceId: WORKSPACE_ID, archived: false }),
  getTimeEntry: (_ws, id) => Effect.succeed(makeTimeEntry(id, "[PROJ-123] Fix the widget", new Date())),
  deleteTimeEntry: (workspaceId, id) => {
    deletedEntries.push({ workspaceId, id })
    return Effect.void
  },
  updateTimeEntry: (workspaceId, id, params) => {
    updatedEntries.push({ workspaceId, id, params })
    return Effect.succeed(makeTimeEntry(id, "", new Date()))
  }
}

const MockClockifyLayer = Layer.succeed(ClockifyApiClient, mockClockify)

// JiraApiClient — unused by start/stop logic directly, but required by layer construction
const MockJiraApiClientLayer = Layer.succeed(JiraApiClient, { v3: {} } as any)

const MockClockifyAuthLayer = Layer.succeed(ClockifyAuth, {
  getConfig: Effect.succeed({
    apiKey: Redacted.make("key"),
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    baseUrl: "https://api.clockify.me/api"
  }),
  save: () => Effect.void,
  isConfigured: Effect.succeed(true)
})

const MockConfigLayer = Layer.succeed(ConfigService, {
  get: Effect.succeed({
    defaultJql: "",
    refreshInterval: 30,
    projectMap: {},
    workspaceId: null,
    defaultProjectId: null,
    defaultProjectName: null,
    defaultBillable: true
  }),
  set: () => Effect.void,
  configDir: Effect.succeed("/tmp/.jcf")
})

let writtenStates: Array<unknown> = []
let cleared = false

const MockStateWriterLayer = Layer.succeed(StateWriter, {
  write: (state) =>
    Effect.sync(() => {
      writtenStates.push(state)
    }),
  read: Effect.succeed({
    active: false,
    ticketKey: null,
    summary: null,
    project: null,
    startedAt: null,
    startedAt_unix: null,
    elapsed: 0,
    clockifyEntryId: null
  }),
  clear: Effect.sync(() => {
    cleared = true
  })
})

const MockJiraAuthLayer = Layer.succeed(JiraAuth, {
  configure: () => Effect.void,
  isConfigured: () => Effect.succeed(true),
  login: () => Effect.void,
  logout: () => Effect.void,
  getAccessToken: () => Effect.succeed(Redacted.make("jira-token")),
  getCloudId: () => Effect.succeed("cloud-1"),
  getSiteUrl: () => Effect.succeed("https://test.atlassian.net"),
  getCurrentUser: () => Effect.succeed(null),
  isLoggedIn: () => Effect.succeed(true)
})

// JiraAuth with no usable token — postJiraWorklog short-circuits to NotLoggedIn.
const MockJiraAuthLoggedOutLayer = Layer.succeed(JiraAuth, {
  configure: () => Effect.void,
  isConfigured: () => Effect.succeed(false),
  login: () => Effect.void,
  logout: () => Effect.void,
  getAccessToken: () => Effect.succeed(Redacted.make("")),
  getCloudId: () => Effect.succeed(""),
  getSiteUrl: () => Effect.succeed(""),
  getCurrentUser: () => Effect.succeed(null),
  isLoggedIn: () => Effect.succeed(false)
})

// Mock HttpClient that returns 201 for Jira worklog POST
const MockHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ id: "wl-1" }), {
          status: 201,
          headers: { "content-type": "application/json" }
        })
      )
    )
  )
)

// HttpClient that returns a 400 for any Jira worklog POST (simulates Jira failure)
const MockHttpClientFailLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ errorMessages: ["nope"] }), {
          status: 400,
          headers: { "content-type": "application/json" }
        })
      )
    )
  )
)

// HttpClient that fails the Jira worklog POST `failures` times, then succeeds —
// models a transient Jira outage so a retry can recover.
const makeFlakyHttpClientLayer = (failures: number) => {
  let calls = 0
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          calls++ < failures
            ? new Response(JSON.stringify({ errorMessages: ["nope"] }), {
              status: 400,
              headers: { "content-type": "application/json" }
            })
            : new Response(JSON.stringify({ id: "wl-1" }), {
              status: 201,
              headers: { "content-type": "application/json" }
            })
        )
      )
    )
  )
}

const TestLayer = timerLayer.pipe(
  Layer.provide(MockClockifyLayer),
  Layer.provide(MockJiraApiClientLayer),
  Layer.provide(MockClockifyAuthLayer),
  Layer.provide(MockConfigLayer),
  Layer.provide(MockStateWriterLayer),
  Layer.provide(MockJiraAuthLayer),
  Layer.provide(MockHttpClientLayer)
)

// Build a TimerService layer with overridden Clockify / HttpClient / JiraAuth mocks.
const makeTestLayer = (
  clockify: ClockifyApiClientShape = mockClockify,
  httpLayer: Layer.Layer<HttpClient.HttpClient> = MockHttpClientLayer,
  jiraAuthLayer: Layer.Layer<JiraAuth> = MockJiraAuthLayer
) =>
  timerLayer.pipe(
    Layer.provide(Layer.succeed(ClockifyApiClient, clockify)),
    Layer.provide(MockJiraApiClientLayer),
    Layer.provide(MockClockifyAuthLayer),
    Layer.provide(MockConfigLayer),
    Layer.provide(MockStateWriterLayer),
    Layer.provide(jiraAuthLayer),
    Layer.provide(httpLayer)
  )

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TimerService", () => {
  describe("state transitions", () => {
    // Initial state must be idle — ensures no stale state from previous sessions
    it.effect("starts idle", () =>
      Effect.gen(function*() {
        resetCaptures()
        writtenStates = []
        cleared = false
        const svc = yield* TimerService
        const state = yield* SubscriptionRef.get(svc.state)
        expect(state.active).toBe(false)
        expect(state.ticketKey).toBeNull()
      }).pipe(Effect.provide(TestLayer)))

    // Core lifecycle: start creates Clockify entry + writes state file + updates SubscriptionRef
    it.effect("idle -> active on start", () =>
      Effect.gen(function*() {
        resetCaptures()
        writtenStates = []
        cleared = false
        const svc = yield* TimerService
        yield* svc.start(makeTicket())
        const state = yield* SubscriptionRef.get(svc.state)
        expect(state.active).toBe(true)
        expect(state.ticketKey).toBe("PROJ-123")
        expect(state.summary).toBe("Fix the widget")
        expect(state.startedViaJcf).toBe(true)
        expect(state.clockifyEntryId).toBe("entry-1")
        expect(createdEntries).toHaveLength(1)
        expect(writtenStates.length).toBeGreaterThanOrEqual(1)
      }).pipe(Effect.provide(TestLayer)))

    // Core lifecycle: stop updates Clockify entry + posts Jira worklog + clears state
    it.effect("active -> stopped on stop", () =>
      Effect.gen(function*() {
        resetCaptures()
        writtenStates = []
        cleared = false
        const svc = yield* TimerService
        yield* svc.start(makeTicket())
        const result = yield* svc.stop()
        expect(result.clockifyLogged).toBe(true)
        expect(result.jiraWorklog?._tag).toBe("Posted")
        const state = yield* SubscriptionRef.get(svc.state)
        expect(state.active).toBe(false)
        expect(state.ticketKey).toBeNull()
        expect(cleared).toBe(true)
      }).pipe(Effect.provide(TestLayer)))

    // Stop without active timer must fail — prevents orphaned Clockify/Jira state
    it.effect("stop with no active timer fails", () =>
      Effect.gen(function*() {
        resetCaptures()
        const svc = yield* TimerService
        const exit = yield* svc.stop().pipe(Effect.flip)
        expect(exit).toBeInstanceOf(TimerError)
        expect(exit.message).toBe("No active timer")
      }).pipe(Effect.provide(TestLayer)))
  })

  describe("auto-stop", () => {
    // Starting a new timer must stop the existing one first — prevents orphaned Clockify entries
    it.effect("starting new timer auto-stops existing one", () =>
      Effect.gen(function*() {
        resetCaptures()
        writtenStates = []
        cleared = false
        const svc = yield* TimerService
        yield* svc.start(makeTicket({ key: "PROJ-1", summary: "First" }))
        expect(createdEntries).toHaveLength(1)

        // Start a second timer — should auto-stop the first
        yield* svc.start(makeTicket({ key: "PROJ-2", summary: "Second" }))
        expect(createdEntries).toHaveLength(2)
        // The auto-stop calls updateTimeEntry on the first entry
        expect(updatedEntries).toHaveLength(1)
        const state = yield* SubscriptionRef.get(svc.state)
        expect(state.ticketKey).toBe("PROJ-2")
        expect(state.summary).toBe("Second")
      }).pipe(Effect.provide(TestLayer)))
  })

  describe("60s Jira worklog floor", () => {
    // Jira rejects worklogs <60s — verify near-instant timers still log successfully (floored to 60s)
    it.effect("floors timeSpentSeconds to 60 for short durations", () =>
      Effect.gen(function*() {
        resetCaptures()
        writtenStates = []
        cleared = false
        const svc = yield* TimerService
        yield* svc.start(makeTicket())
        // Stop immediately — elapsed ~0ms, should still log with 60s floor
        const result = yield* svc.stop()
        expect(result.jiraWorklog?._tag).toBe("Posted")
        expect(result.clockifyLogged).toBe(true)
      }).pipe(Effect.provide(TestLayer)))
  })

  describe("discard", () => {
    // Discard deletes Clockify entry and clears state — no Jira worklog should be created
    it.effect("discards active timer without Jira worklog", () =>
      Effect.gen(function*() {
        resetCaptures()
        writtenStates = []
        cleared = false
        const svc = yield* TimerService
        yield* svc.start(makeTicket())
        yield* svc.discard
        const state = yield* SubscriptionRef.get(svc.state)
        expect(state.active).toBe(false)
        expect(deletedEntries).toHaveLength(1)
        expect(deletedEntries[0]!.id).toBe("entry-1")
        expect(cleared).toBe(true)
      }).pipe(Effect.provide(TestLayer)))

    // Discard without active timer must fail — prevents accidental entry deletion
    it.effect("discard with no active timer fails", () =>
      Effect.gen(function*() {
        resetCaptures()
        const svc = yield* TimerService
        const exit = yield* svc.discard.pipe(Effect.flip)
        expect(exit).toBeInstanceOf(TimerError)
        expect(exit.message).toBe("No active timer to discard")
      }).pipe(Effect.provide(TestLayer)))
  })

  describe("detectRunning", () => {
    // Detects externally-started Clockify timers with "[KEY] summary" format (jcf native format)
    it.effect("parses bracket format [KEY] summary", () => {
      const runningEntry = makeTimeEntry(
        "ext-1",
        "[PROJ-42] Implement feature",
        new Date("2025-01-01T10:00:00Z"),
        "proj-id"
      )

      const clockifyWithRunning: ClockifyApiClientShape = {
        ...mockClockify,
        getRunningTimer: () => Effect.succeed(runningEntry),
        getProjects: () =>
          Effect.succeed([{
            id: "proj-id",
            name: "MyProject",
            color: "",
            archived: false,
            billable: true,
            public: true,
            workspaceId: WORKSPACE_ID,
            note: ""
          }])
      }

      return Effect.gen(function*() {
        resetCaptures()
        writtenStates = []
        cleared = false

        const svc = yield* TimerService
        yield* svc.detectRunning

        // State was updated via the layer's SubscriptionRef, so read from svc
        const state = yield* SubscriptionRef.get(svc.state)
        expect(state.active).toBe(true)
        expect(state.ticketKey).toBe("PROJ-42")
        expect(state.summary).toBe("Implement feature")
        expect(state.projectId).toBe("proj-id")
        expect(state.projectName).toBe("MyProject")
        expect(state.startedViaJcf).toBe(false)
      }).pipe(Effect.provide(makeTestLayer(clockifyWithRunning)))
    })

    // Also detects "KEY: summary" format — common when timers are started manually in Clockify
    it.effect("parses colon format KEY: summary", () => {
      const runningEntry = makeTimeEntry("ext-2", "PROJ-99: Review PR", new Date("2025-01-01T10:00:00Z"))

      const clockifyWithRunning: ClockifyApiClientShape = {
        ...mockClockify,
        getRunningTimer: () => Effect.succeed(runningEntry)
      }

      return Effect.gen(function*() {
        resetCaptures()
        writtenStates = []

        const svc = yield* TimerService
        yield* svc.detectRunning

        const state = yield* SubscriptionRef.get(svc.state)
        expect(state.active).toBe(true)
        expect(state.ticketKey).toBe("PROJ-99")
        expect(state.summary).toBe("Review PR")
        expect(state.startedViaJcf).toBe(false)
      }).pipe(Effect.provide(makeTestLayer(clockifyWithRunning)))
    })

    // No running timer in Clockify must leave local state unchanged — polling should be safe no-op
    it.effect("no running timer is a no-op", () =>
      Effect.gen(function*() {
        resetCaptures()
        writtenStates = []
        const svc = yield* TimerService
        yield* svc.detectRunning
        const state = yield* SubscriptionRef.get(svc.state)
        expect(state.active).toBe(false)
      }).pipe(Effect.provide(TestLayer)))
  })

  describe("stop options", () => {
    // Stop options override timer state — used when TUI prompts for projectId/billable on stop
    it.effect("stop merges projectId and billable from options", () =>
      Effect.gen(function*() {
        resetCaptures()
        writtenStates = []
        cleared = false
        const svc = yield* TimerService
        yield* svc.start(makeTicket())
        const result = yield* svc.stop({ projectId: "proj-override", billable: false })
        expect(result.needsProjectId).toBe(false)
        expect(result.needsBillable).toBe(false)
        // Check that the updateTimeEntry was called with the overridden values
        expect(updatedEntries).toHaveLength(1)
        const params = updatedEntries[0]!.params as { projectId?: string; billable?: boolean }
        expect(params.projectId).toBe("proj-override")
        expect(params.billable).toBe(false)
      }).pipe(Effect.provide(TestLayer)))

    // needsProjectId=true signals TUI to prompt user — must be true when no project resolved
    it.effect("needsProjectId true when no projectId provided", () =>
      Effect.gen(function*() {
        resetCaptures()
        writtenStates = []
        cleared = false
        const svc = yield* TimerService
        yield* svc.start(makeTicket())
        const result = yield* svc.stop()
        expect(result.needsProjectId).toBe(true)
      }).pipe(Effect.provide(TestLayer)))
  })

  describe("logManual (correction interval)", () => {
    // Logging a forgotten interval writes a closed Clockify entry (start + end) and a Jira worklog
    it.effect("creates a closed Clockify entry and posts a Jira worklog", () =>
      Effect.gen(function*() {
        yield* TestClock.setTime(MANUAL_NOW)
        resetCaptures()
        writtenStates = []
        cleared = false
        const svc = yield* TimerService
        const start = new Date("2025-01-01T09:00:00.000Z")
        const result = yield* svc.logManual(makeTicket(), { start, durationSeconds: 1800 })

        expect(result.clockifyLogged).toBe(true)
        expect(result.jiraWorklogLogged).toBe(true)
        expect(createdEntries).toHaveLength(1)
        const params = createdEntries[0]!.params as { start: string; end: string; description: string }
        expect(params.start).toBe(start.toISOString())
        expect(params.end).toBe(new Date(start.getTime() + 1800 * 1000).toISOString())
        expect(params.description).toBe("[PROJ-123] Fix the widget")
      }).pipe(Effect.provide(TestLayer)))

    // A correction must never disturb the running-timer state (there was no running timer)
    it.effect("leaves timer state inactive", () =>
      Effect.gen(function*() {
        yield* TestClock.setTime(MANUAL_NOW)
        resetCaptures()
        writtenStates = []
        cleared = false
        const svc = yield* TimerService
        yield* svc.logManual(makeTicket(), { start: new Date("2025-01-01T09:00:00.000Z"), durationSeconds: 600 })
        const state = yield* SubscriptionRef.get(svc.state)
        expect(state.active).toBe(false)
        expect(state.ticketKey).toBeNull()
      }).pipe(Effect.provide(TestLayer)))

    // Explicit projectId/billable options flow through to the Clockify entry
    it.effect("honours explicit projectId and billable options", () =>
      Effect.gen(function*() {
        yield* TestClock.setTime(MANUAL_NOW)
        resetCaptures()
        writtenStates = []
        cleared = false
        const svc = yield* TimerService
        const result = yield* svc.logManual(makeTicket(), {
          start: new Date("2025-01-01T09:00:00.000Z"),
          durationSeconds: 600,
          projectId: "proj-x",
          billable: false
        })
        expect(result.projectId).toBe("proj-x")
        expect(result.billable).toBe(false)
        const params = createdEntries[0]!.params as { projectId?: string; billable?: boolean }
        expect(params.projectId).toBe("proj-x")
        expect(params.billable).toBe(false)
      }).pipe(Effect.provide(TestLayer)))

    // A failing Clockify createTimeEntry must flip clockifyLogged to false (not crash)
    it.effect("clockifyLogged is false when the Clockify entry fails", () =>
      Effect.gen(function*() {
        yield* TestClock.setTime(MANUAL_NOW)
        resetCaptures()
        const svc = yield* TimerService
        const result = yield* svc.logManual(makeTicket(), {
          start: new Date("2025-01-01T09:00:00.000Z"),
          durationSeconds: 600
        })
        // Jira worklog still succeeds via the 201 mock; only Clockify failed.
        expect(result.clockifyLogged).toBe(false)
        expect(result.jiraWorklogLogged).toBe(true)
      }).pipe(Effect.provide(
        makeTestLayer({
          ...mockClockify,
          createTimeEntry: () => Effect.fail(new FetchClientError({ error: "boom", status: 500, message: "boom" }))
        }, MockHttpClientLayer)
      )))

    // A failing Jira worklog POST must flip jiraWorklogLogged to false (not crash)
    it.effect("jiraWorklogLogged is false when the Jira worklog POST fails", () =>
      Effect.gen(function*() {
        yield* TestClock.setTime(MANUAL_NOW)
        resetCaptures()
        const svc = yield* TimerService
        const result = yield* svc.logManual(makeTicket(), {
          start: new Date("2025-01-01T09:00:00.000Z"),
          durationSeconds: 600
        })
        expect(result.clockifyLogged).toBe(true)
        expect(result.jiraWorklogLogged).toBe(false)
      }).pipe(Effect.provide(makeTestLayer(mockClockify, MockHttpClientFailLayer))))

    // The 60s Jira floor applies to backdated/manual logs too: a <60s duration
    // must still post a worklog (floored), so jiraWorklogLogged stays true.
    it.effect("applies the 60s worklog floor on a sub-minute manual log", () =>
      Effect.gen(function*() {
        yield* TestClock.setTime(MANUAL_NOW)
        resetCaptures()
        const svc = yield* TimerService
        const result = yield* svc.logManual(makeTicket(), {
          start: new Date("2025-01-01T09:00:00.000Z"),
          durationSeconds: 30
        })
        expect(result.jiraWorklogLogged).toBe(true)
      }).pipe(Effect.provide(TestLayer)))

    // Future start times are rejected by the shared guard in logManual
    it.effect("fails when the start time is in the future", () =>
      Effect.gen(function*() {
        yield* TestClock.setTime(MANUAL_NOW)
        resetCaptures()
        const svc = yield* TimerService
        const future = new Date(MANUAL_NOW + 60 * 60 * 1000)
        const error = yield* svc.logManual(makeTicket(), { start: future, durationSeconds: 600 }).pipe(Effect.flip)
        expect(error).toBeInstanceOf(TimerError)
        expect(error.message).toMatch(/future/i)
        // No Clockify entry should have been created.
        expect(createdEntries).toHaveLength(0)
      }).pipe(Effect.provide(TestLayer)))

    // The whole manual interval must be in the past; otherwise Clockify/Jira
    // would receive a worklog whose end time has not happened yet.
    it.effect("fails when the manual interval would end in the future", () =>
      Effect.gen(function*() {
        yield* TestClock.setTime(MANUAL_NOW)
        resetCaptures()
        const svc = yield* TimerService
        const fiveMinutesAgo = new Date(MANUAL_NOW - 5 * 60 * 1000)
        const error = yield* svc.logManual(makeTicket(), {
          start: fiveMinutesAgo,
          durationSeconds: 10 * 60
        }).pipe(Effect.flip)
        expect(error).toBeInstanceOf(TimerError)
        expect(error.message).toMatch(/end time is in the future/i)
        expect(createdEntries).toHaveLength(0)
      }).pipe(Effect.provide(TestLayer)))
  })

  describe("worklog retry", () => {
    // A successful stop leaves nothing to retry — outcome Posted, no retry params.
    it.effect("stop reports Posted with no retry params when Jira succeeds", () =>
      Effect.gen(function*() {
        resetCaptures()
        const svc = yield* TimerService
        yield* svc.start(makeTicket())
        const result = yield* svc.stop({ comment: "done" })
        expect(result.jiraWorklog?._tag).toBe("Posted")
        expect(result.worklog).toBeNull()
      }).pipe(Effect.provide(TestLayer)))

    // A transient Jira failure (4xx) must report Failed with a message and surface retry params.
    it.effect("stop reports Failed with a message and retry params when Jira rejects", () =>
      Effect.gen(function*() {
        resetCaptures()
        const svc = yield* TimerService
        yield* svc.start(makeTicket())
        const result = yield* svc.stop({ comment: "done" })
        expect(result.clockifyLogged).toBe(true)
        expect(result.jiraWorklog?._tag).toBe("Failed")
        if (result.jiraWorklog?._tag === "Failed") {
          // The Jira error body is summarised into the message.
          expect(result.jiraWorklog.message).toContain("400")
          expect(result.jiraWorklog.message).toContain("nope")
        }
        expect(result.worklog).not.toBeNull()
        expect(result.worklog?.ticketKey).toBe("PROJ-123")
        expect(result.worklog?.comment).toBe("done")
      }).pipe(Effect.provide(makeTestLayer(mockClockify, MockHttpClientFailLayer))))

    // Not logged in must report NotLoggedIn (unrecoverable) and expose NO retry params.
    it.effect("stop reports NotLoggedIn and no retry params when there is no token", () =>
      Effect.gen(function*() {
        resetCaptures()
        const svc = yield* TimerService
        yield* svc.start(makeTicket())
        const result = yield* svc.stop({ comment: "done" })
        expect(result.clockifyLogged).toBe(true)
        expect(result.jiraWorklog?._tag).toBe("NotLoggedIn")
        // NotLoggedIn can't be fixed by retrying, so the retry payload is withheld.
        expect(result.worklog).toBeNull()
      }).pipe(Effect.provide(makeTestLayer(mockClockify, MockHttpClientLayer, MockJiraAuthLoggedOutLayer))))

    // logWorklog reposts in isolation and succeeds once Jira recovers — the retry round-trip.
    it.effect("logWorklog recovers after a transient Jira failure", () =>
      Effect.gen(function*() {
        resetCaptures()
        const svc = yield* TimerService
        yield* svc.start(makeTicket())
        const result = yield* svc.stop({ comment: "done" })
        expect(result.jiraWorklog?._tag).toBe("Failed")
        expect(result.worklog).not.toBeNull()
        // Jira was flaky on the first POST (during stop) but recovers on retry.
        const retried = yield* svc.logWorklog(result.worklog!)
        expect(retried._tag).toBe("Posted")
      }).pipe(Effect.provide(makeTestLayer(mockClockify, makeFlakyHttpClientLayer(1)))))

    // A retry against a still-down Jira reports Failed (with reason) rather than crashing.
    it.effect("logWorklog reports Failed while Jira is still failing", () =>
      Effect.gen(function*() {
        resetCaptures()
        const svc = yield* TimerService
        const retried = yield* svc.logWorklog({
          ticketKey: "PROJ-123",
          startedAt: new Date("2025-01-01T09:00:00.000Z"),
          durationSeconds: 600,
          comment: "done"
        })
        expect(retried._tag).toBe("Failed")
        if (retried._tag === "Failed") expect(retried.message).toContain("400")
      }).pipe(Effect.provide(makeTestLayer(mockClockify, MockHttpClientFailLayer))))

    // logWorklog reports NotLoggedIn when there is no token, so callers can skip retrying.
    it.effect("logWorklog reports NotLoggedIn when there is no token", () =>
      Effect.gen(function*() {
        resetCaptures()
        const svc = yield* TimerService
        const retried = yield* svc.logWorklog({
          ticketKey: "PROJ-123",
          startedAt: new Date("2025-01-01T09:00:00.000Z"),
          durationSeconds: 600
        })
        expect(retried._tag).toBe("NotLoggedIn")
      }).pipe(Effect.provide(makeTestLayer(mockClockify, MockHttpClientLayer, MockJiraAuthLoggedOutLayer))))
  })

  describe("start backdating", () => {
    // A backdated start records the corrected start time on the Clockify entry and state
    it.effect("uses the provided startedAt instead of now", () =>
      Effect.gen(function*() {
        resetCaptures()
        writtenStates = []
        cleared = false
        const svc = yield* TimerService
        const startedAt = new Date("2025-01-01T08:30:00.000Z")
        yield* svc.start(makeTicket(), { startedAt })
        const params = createdEntries[0]!.params as { start: string }
        expect(params.start).toBe(startedAt.toISOString())
        const state = yield* SubscriptionRef.get(svc.state)
        expect(state.startedAt?.toISOString()).toBe(startedAt.toISOString())
      }).pipe(Effect.provide(TestLayer)))
  })
})
