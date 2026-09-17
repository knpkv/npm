import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { AgentSessionReader, IssueFacts, ReconcileService } from "@knpkv/jira-clockify"
import { FAKE_HOME, type FakeHeadlessOptions, makeFakeHeadless } from "@knpkv/jira-clockify/testing.js"
import { Deferred, Effect, Layer, Redacted } from "effect"
import { Etag, HttpPlatform, HttpRouter } from "effect/unstable/http"
import { readWeekStream } from "../src/client/api.js"
import { decodeSavedWeek } from "../src/client/decoding.js"
import { application } from "../src/server/HttpApplication.js"
import { makeOwnerSessionSecrets, ownerSessionCookie, OwnerSessionSecrets } from "../src/server/OwnerSession.js"
import type { ReadProgress, WeekScopeName } from "../src/shared/contracts.js"

// These are HTTP application entry points over isolated provider fixtures.
// @effect-diagnostics strictEffectProvide:off
const origin = "http://127.0.0.1:4179"
const monday = "2026-09-07"
const at = (hour: number) => new Date(2026, 8, 7, hour).toISOString()
const transcript = Array.from({ length: 61 }, (_, minute) =>
  JSON.stringify({
    cwd: `${FAKE_HOME}/dev/work/repo`,
    gitBranch: "main",
    isSidechain: false,
    message: { content: "Implement PROJ-5662", role: "user" },
    sessionId: "session-a",
    timestamp: new Date(2026, 8, 7, 10, minute).toISOString(),
    type: "user",
    uuid: `prompt-${minute}`,
    version: "9.9.9"
  })).join("\n")

/** Compose the real engine and HTTP application; observe reads without replacing their behavior. */
const makeApplication = async (
  options: FakeHeadlessOptions = {},
  beforeRecordedRead: () => Effect.Effect<void> = () => Effect.void
) => {
  const secrets = await Effect.runPromise(makeOwnerSessionSecrets(origin).pipe(Effect.provide(NodeCrypto.layer)))
  const fake = makeFakeHeadless({
    config: { sessionRoots: [`${FAKE_HOME}/dev/work`], sessionOwnership: "assigned" },
    clockifyEntries: [
      { description: "[PROJ-5662] Logged work", start: at(8), end: at(9) },
      { description: "Team planning", start: at(9), end: at(10) }
    ],
    jiraWorklogs: { "PROJ-5662": [{ started: at(8), timeSpentSeconds: 1800 }] },
    transcripts: { "repo/session.jsonl": transcript },
    attributor: () => ({ _tag: "Chosen", ticketKey: "PROJ-5662", confidence: 1 }),
    ...options
  })
  const calls = { sessions: 0, ownership: 0, recorded: 0 }
  const reader = Layer.effect(
    AgentSessionReader.AgentSessionReader,
    Effect.gen(function*() {
      const original = yield* AgentSessionReader.AgentSessionReader
      return AgentSessionReader.AgentSessionReader.of({
        read: (period) => Effect.sync(() => calls.sessions++).pipe(Effect.andThen(original.read(period)))
      })
    })
  ).pipe(Layer.provide(fake.layer))
  const engine = Layer.fresh(ReconcileService.layer).pipe(Layer.provide(reader), Layer.provide(fake.layer))
  const recorded = Layer.effect(
    ReconcileService.ReconcileService,
    Effect.gen(function*() {
      const original = yield* ReconcileService.ReconcileService
      return ReconcileService.ReconcileService.of({
        ...original,
        refreshRecordedTime: (period, previous) =>
          Effect.gen(function*() {
            calls.recorded++
            yield* beforeRecordedRead()
            return yield* original.refreshRecordedTime(period, previous)
          })
      })
    })
  ).pipe(Layer.provide(engine))
  const ownership = Layer.effect(
    IssueFacts.IssueFacts,
    Effect.gen(function*() {
      const original = yield* IssueFacts.IssueFacts
      return IssueFacts.IssueFacts.of({
        lookup: (keys) => Effect.sync(() => calls.ownership++).pipe(Effect.andThen(original.lookup(keys)))
      })
    })
  ).pipe(Layer.provide(fake.layer))
  const app = application.pipe(
    Layer.provide(recorded),
    Layer.provide(ownership),
    Layer.provide(fake.layer),
    Layer.provideMerge(Layer.succeed(OwnerSessionSecrets, secrets)),
    Layer.provide(Etag.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(HttpPlatform.layer.pipe(Layer.provide(NodeServices.layer)))
  )
  const web = HttpRouter.toWebHandler(app, { disableLogger: true })
  const get = (path: string) =>
    web.handler(
      new Request(`${origin}${path}`, {
        headers: { cookie: ownerSessionCookie(secrets) }
      })
    )
  const read = async (path: string, progress: Array<ReadProgress> = []) =>
    readWeekStream(await get(path), (event) => progress.push(event))
  return { web, secrets, fake, calls, get, read }
}

it.each<WeekScopeName>(["both", "jira", "clockify"])(
  "streams recorded %s time on a restore miss without reading sessions or ownership",
  async (scope) => {
    const app = await makeApplication()
    try {
      const savedPath = `/api/week/saved?monday=${monday}&only=${scope}`
      expect(await (await app.get(savedPath)).json()).toMatchObject({ plan: null })
      expect(app.calls).toEqual({ sessions: 0, ownership: 0, recorded: 0 })
      const path = `/api/week/recorded-only?monday=${monday}&only=${scope}`
      expect((await app.web.handler(new Request(`${origin}${path}`))).status).toBe(401)
      const response = await app.get(path)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("application/x-ndjson")
      const progress: Array<ReadProgress> = []
      const plan = await readWeekStream(response, (event) => progress.push(event))
      expect(progress.map((event) => event.stage)).toEqual(["recorded", "calendar"])
      expect(plan).toMatchObject({
        monday,
        scope,
        sessionScanAvailable: false,
        sessionCount: 0,
        attributorCalls: 0,
        sessionRootCount: 1,
        ownershipChecked: false,
        ownership: "any",
        unattributed: [],
        withheld: []
      })
      expect(plan.rows).toHaveLength(1)
      expect(plan.rows[0]).toMatchObject({
        ticketKey: "PROJ-5662",
        day: monday,
        clockifySeconds: scope === "jira" ? 0 : 3600,
        jiraSeconds: scope === "clockify" ? 0 : 1800
      })
      expect(plan.rows[0]?.proposal).toBeUndefined()
      expect(plan.unlinkedClockify).toHaveLength(scope === "jira" ? 0 : 1)
      if (scope !== "jira") {
        expect(plan.unlinkedClockify[0]).toMatchObject({ description: "Team planning", seconds: 3600 })
      }
      expect(app.calls).toEqual({ sessions: 0, ownership: 0, recorded: 1 })
      expect(app.fake.world.transcriptReads).toEqual([])
      expect(app.fake.world.attributorBatches).toEqual([])
      expect(app.fake.world.describeBatches).toEqual([])
      const saved = await decodeSavedWeek(await (await app.get(savedPath)).json())
      expect(saved.plan).toEqual(plan)
      expect(app.calls.recorded).toBe(1)
    } finally {
      await app.web.dispose()
    }
  }
)

it("allows a manual write then refreshes its provider totals while retaining the no-scan flag", async () => {
  const app = await makeApplication()
  try {
    const plan = await app.read(`/api/week/recorded-only?monday=${monday}&only=both`)
    const body = JSON.stringify({
      ticketKey: "PROJ-5662",
      day: monday,
      seconds: 900,
      startClock: "14:00",
      note: "Manual work",
      targets: { jira: true, clockify: true }
    })
    const headers = { cookie: ownerSessionCookie(app.secrets), "content-type": "application/json" }
    expect(
      (await app.web.handler(
        new Request(`${origin}/api/rows/manual`, {
          method: "POST",
          headers,
          body
        })
      )).status
    ).toBe(403)
    const written = await app.web.handler(
      new Request(`${origin}/api/rows/manual`, {
        method: "POST",
        body,
        headers: { ...headers, origin, "x-csrf-token": Redacted.value(app.secrets.csrfToken) }
      })
    )
    expect(written.status).toBe(200)
    expect(app.fake.world.createdClockifyEntries).toHaveLength(1)
    expect(app.fake.world.jiraWorklogs).toHaveLength(1)
    const refreshed = await app.read(`/api/week/recorded?planId=${plan.planId}`)
    expect(refreshed).toMatchObject({ planId: plan.planId, sessionScanAvailable: false })
    expect(refreshed.rows[0]).toMatchObject({ clockifySeconds: 4500, jiraSeconds: 2700 })
    expect(refreshed.rows[0]?.proposal).toBeUndefined()
    const restored = await decodeSavedWeek(await (await app.get(`/api/week/saved?monday=${monday}&only=both`)).json())
    expect(restored.plan).toEqual(refreshed)
    expect(app.calls).toEqual({ sessions: 0, ownership: 0, recorded: 2 })
    expect(app.fake.world.attributorBatches).toEqual([])
    expect(app.fake.world.transcriptReads).toEqual([])
    expect(app.fake.world.describeBatches).toEqual([])
  } finally {
    await app.web.dispose()
  }
})

it("checks running timers only for Clockify scope and never counts them as closed logged time", async () => {
  const app = await makeApplication({ runningTimer: { description: "[PROJ-5662] Running", start: at(11) } })
  try {
    const clockify = await app.read(`/api/week/recorded-only?monday=${monday}&only=clockify`)
    expect(clockify.excludedDays.map((entry) => entry.day)).toEqual(clockify.days)
    expect(clockify.excludedDays.every((entry) => entry.reason.includes("timer is still running"))).toBe(true)
    expect(clockify.rows[0]?.clockifySeconds).toBe(3600)
    expect(clockify.unlinkedClockify).toHaveLength(1)
    const jira = await app.read(`/api/week/recorded-only?monday=${monday}&only=jira`)
    expect(jira.excludedDays).toEqual([])
    expect(jira.rows[0]?.jiraSeconds).toBe(1800)
    expect(app.calls.sessions).toBe(0)
  } finally {
    await app.web.dispose()
  }
})

it("does not call Jira in Clockify-only scope, and reports a selected provider failure without scanning", async () => {
  const app = await makeApplication({ jiraWorklogReadFails: true })
  try {
    expect((await app.read(`/api/week/recorded-only?monday=${monday}&only=clockify`)).rows[0]?.clockifySeconds).toBe(
      3600
    )
    await expect(app.read(`/api/week/recorded-only?monday=${monday}&only=jira`)).rejects.toThrow()
    expect(app.calls.sessions).toBe(0)
    expect(app.calls.ownership).toBe(0)
    expect(app.fake.world.attributorBatches).toEqual([])
    expect(await (await app.get(`/api/week/saved?monday=${monday}&only=jira`)).json()).toMatchObject({ plan: null })
  } finally {
    await app.web.dispose()
  }
})

it("retains an explicit scan that finishes during a recorded-only read and reuses its evidence later", async () => {
  const started = await Effect.runPromise(Deferred.make<void>())
  const resume = await Effect.runPromise(Deferred.make<void>())
  const app = await makeApplication(
    {},
    () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(resume)))
  )
  try {
    const pending = app.read(`/api/week/recorded-only?monday=${monday}&only=clockify`)
    await Effect.runPromise(Deferred.await(started))
    const scanned = await app.read(`/api/week/stream?monday=${monday}&only=clockify`)
    expect(scanned.sessionScanAvailable).toBe(true)
    expect(scanned.rows.some((row) => row.proposal !== undefined)).toBe(true)
    await Effect.runPromise(Deferred.succeed(resume, undefined))
    expect(await pending).toEqual(scanned)
    const reused = await app.read(`/api/week/recorded-only?monday=${monday}&only=clockify`)
    expect(reused).toEqual(scanned)
    expect(app.calls.sessions).toBe(1)
    expect(app.fake.world.attributorBatches).toHaveLength(1)
    expect(app.fake.world.transcriptReads).toHaveLength(1)
  } finally {
    await Effect.runPromise(Deferred.succeed(resume, undefined))
    await app.web.dispose()
  }
})
