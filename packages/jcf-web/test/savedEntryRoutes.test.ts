import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { ReconcileService, SavedEntries, SessionAttributor } from "@knpkv/jira-clockify"
import { FAKE_HOME, type FakeHeadlessOptions, makeFakeHeadless } from "@knpkv/jira-clockify/testing.js"
import { Deferred, Effect, Layer, Redacted, Schema } from "effect"
import { Etag, HttpPlatform, HttpRouter } from "effect/unstable/http"
import { readWeekStream } from "../src/client/api.js"
import { application } from "../src/server/HttpApplication.js"
import { makeOwnerSessionSecrets, ownerSessionCookie, OwnerSessionSecrets } from "../src/server/OwnerSession.js"
import { DescribeSavedEntryResponse, SavedWeek, UpdateSavedEntryResponse, WeekPlan } from "../src/shared/contracts.js"
import type { SavedEntry, WeekPlanResponse, WeekScopeName } from "../src/shared/contracts.js"

// Production HTTP composition over fake providers and agent; no listener, real writes or agent processes.
// @effect-diagnostics strictEffectProvide:off
const origin = "http://127.0.0.1:4179"
const monday = "2026-09-07"
const at = (hour: number) => new Date(2026, 8, 7, hour).toISOString()
const summary = "Implemented approval queue with Undo"

interface RouteCalls {
  readonly updates: Array<SavedEntries.SavedEntryUpdate>
  failure: SavedEntries.SavedEntryError["reason"] | null
}

const transcript = (sessionId: string, hour: number, ticketKey = "PROJ-5662") =>
  Array.from({ length: 61 }, (_, minute) =>
    JSON.stringify({
      cwd: `${FAKE_HOME}/dev/work/repo`,
      gitBranch: `feature/${ticketKey}`,
      isSidechain: false,
      message: { content: summary, role: "user" },
      sessionId,
      timestamp: new Date(2026, 8, 7, hour, minute).toISOString(),
      type: "user",
      uuid: `${sessionId}-${minute}`,
      version: "9.9.9"
    })).join("\n")

/** Run production retained-week, update and session correlation over isolated provider ledgers. */
const makeApplication = async (options: {
  readonly fake?: FakeHeadlessOptions
  readonly beforeDescribe?: () => Effect.Effect<void>
  readonly afterRefresh?: () => Effect.Effect<void>
  readonly afterScan?: () => Effect.Effect<void>
  readonly legacy?: boolean
} = {}) => {
  const secrets = await Effect.runPromise(makeOwnerSessionSecrets(origin).pipe(Effect.provide(NodeCrypto.layer)))
  const fake = makeFakeHeadless({
    config: { sessionRoots: [`${FAKE_HOME}/dev/work`], sessionOwnership: "any" },
    clockifyEntries: [
      { description: "[PROJ-5662] Existing exact work", start: at(10), end: at(11) },
      { description: "Planning", start: at(10), end: at(11) },
      { description: "[PROJ-5662] Evening", start: at(20), end: at(21) }
    ],
    jiraWorklogs: { "PROJ-5662": [{ started: at(10), timeSpentSeconds: 3600 }] },
    transcripts: {
      "repo/morning.jsonl": transcript("morning", 10),
      "repo/afternoon.jsonl": transcript("afternoon", 14),
      "repo/wrong-ticket.jsonl": transcript("wrong-ticket", 20, "PROJ-5777")
    },
    describer: () => summary,
    ...options.fake
  })
  const calls: RouteCalls = {
    updates: new Array<SavedEntries.SavedEntryUpdate>(),
    failure: null
  }
  const updates = Layer.effect(
    SavedEntries.SavedEntries,
    Effect.gen(function*() {
      const original = yield* SavedEntries.SavedEntries
      return SavedEntries.SavedEntries.of({
        update: Effect.fn("Test.savedUpdate")(function*(input) {
          calls.updates.push(input)
          if (calls.failure !== null) {
            return yield* new SavedEntries.SavedEntryError({ reason: calls.failure, message: `test ${calls.failure}` })
          }
          return yield* original.update(input)
        })
      })
    })
  ).pipe(Layer.provide(fake.layer))
  const attributor = Layer.effect(
    SessionAttributor.SessionAttributor,
    Effect.gen(function*() {
      const original = yield* SessionAttributor.SessionAttributor
      return SessionAttributor.SessionAttributor.of({
        ...original,
        describe: (requests) =>
          (options.beforeDescribe?.() ?? Effect.void).pipe(Effect.andThen(original.describe(requests)))
      })
    })
  ).pipe(Layer.provide(fake.layer))
  const engine = Layer.effect(
    ReconcileService.ReconcileService,
    Effect.gen(function*() {
      const original = yield* ReconcileService.ReconcileService
      const withoutMetadata = (
        report: ReconcileService.SessionProposalReport
      ): ReconcileService.SessionProposalReport => ({
        ...report,
        recorded: report.recorded.map((row) => ({
          ...row,
          intervals: row.intervals.map(({ endMs, source, startMs }) => ({ startMs, endMs, source }))
        })),
        unlinkedClockify: report.unlinkedClockify.map(({ day, description, endMs, seconds, startMs }) => ({
          startMs,
          endMs,
          day,
          seconds,
          description
        }))
      })
      return ReconcileService.ReconcileService.of({
        ...original,
        proposeFromSessions: (period, request) =>
          original.proposeFromSessions(period, request).pipe(
            Effect.tap(() => options.afterScan?.() ?? Effect.void),
            Effect.map((report) => options.legacy ? withoutMetadata(report) : report)
          ),
        refreshRecordedTime: (period, previous) =>
          original.refreshRecordedTime(period, previous).pipe(
            Effect.tap(() => options.afterRefresh?.() ?? Effect.void)
          )
      })
    })
  ).pipe(Layer.provide(fake.layer))
  const app = application.pipe(
    Layer.provide(updates),
    Layer.provide(attributor),
    Layer.provide(engine),
    Layer.provide(fake.layer),
    Layer.provideMerge(Layer.succeed(OwnerSessionSecrets, secrets)),
    Layer.provide(Etag.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(HttpPlatform.layer.pipe(Layer.provide(NodeServices.layer)))
  )
  const web = HttpRouter.toWebHandler(app, { disableLogger: true })
  const get = (path: string) =>
    web.handler(new Request(`${origin}${path}`, { headers: { cookie: ownerSessionCookie(secrets) } }))
  const post = (
    path: string,
    body: Schema.Json,
    auth: "owner" | "no-csrf" | "none" | "wrong-origin" | "wrong-csrf" = "owner"
  ) => {
    const headers = new Headers({ "content-type": "application/json" })
    if (auth !== "none") headers.set("cookie", ownerSessionCookie(secrets))
    if (auth === "owner" || auth === "wrong-origin" || auth === "wrong-csrf") {
      headers.set("origin", auth === "wrong-origin" ? "http://untrusted.example" : origin)
      headers.set("x-csrf-token", auth === "wrong-csrf" ? "invalid-token" : Redacted.value(secrets.csrfToken))
    }
    return web.handler(
      new Request(`${origin}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      })
    )
  }
  const read = async (scope: WeekScopeName = "both") => {
    const response = await get(`/api/week/?monday=${monday}&only=${scope}`)
    expect(response.status).toBe(200)
    return Schema.decodeUnknownPromise(Schema.toCodecJson(WeekPlan))(await response.json())
  }
  const retained = async () =>
    Schema.decodeUnknownPromise(Schema.toCodecJson(SavedWeek))(
      await (await get(`/api/week/saved?monday=${monday}`)).json()
    )
  return { web, fake, calls, get, post, read, retained }
}

const entryFor = (plan: WeekPlanResponse, source: SavedEntry["source"], startMs = Date.parse(at(10))) => {
  const entry = plan.rows.flatMap((row) => row.intervals).find((interval) =>
    interval.entry?.source === source && interval.entry.startMs === startMs
  )?.entry
  expect(entry).toBeDefined()
  if (entry === undefined) throw new TypeError("Missing saved entry fixture")
  return entry
}
const identity = (plan: WeekPlanResponse, entry: SavedEntry) => ({
  planId: plan.planId,
  source: entry.source,
  entryId: entry.id
})
const edit = (plan: WeekPlanResponse, entry: SavedEntry, description = entry.description ?? "") => ({
  ...identity(plan, entry),
  revision: entry.revision,
  startMs: entry.startMs,
  endMs: entry.endMs,
  description
})

it("requires owner cookie and CSRF for both entry routes, and rejects unknown/provider/legacy identities", async () => {
  const app = await makeApplication()
  try {
    const plan = await app.read("clockify")
    const entry = entryFor(plan, "clockify")
    for (const route of ["update", "describe"]) {
      const payload = route === "update" ? edit(plan, entry) : identity(plan, entry)
      expect((await app.post(`/api/entries/${route}`, payload, "none")).status).toBe(401)
      expect((await app.post(`/api/entries/${route}`, payload, "no-csrf")).status).toBe(403)
      expect((await app.post(`/api/entries/${route}`, payload, "wrong-origin")).status).toBe(403)
      expect((await app.post(`/api/entries/${route}`, payload, "wrong-csrf")).status).toBe(403)
      for (const wrong of [{ entryId: "unknown" }, { planId: "unknown" }, { source: "jira" }]) {
        expect((await app.post(`/api/entries/${route}`, { ...payload, ...wrong })).status).toBe(409)
      }
    }
    expect(app.calls.updates).toHaveLength(0)
    const missingRevision = {
      ...identity(plan, entry),
      startMs: entry.startMs,
      endMs: entry.endMs,
      description: "Old browser"
    }
    expect((await app.post("/api/entries/update", missingRevision)).status).toBe(400)
    expect((await app.post("/api/entries/update", { ...edit(plan, entry), revision: "forged" })).status).toBe(409)
    expect(app.calls.updates).toHaveLength(0)
    expect(app.fake.world.describeRequests).toHaveLength(0)
    await app.read("clockify")
    expect((await app.post("/api/entries/update", edit(plan, entry))).status).toBe(409)
  } finally {
    await app.web.dispose()
  }
  const legacy = await makeApplication({ legacy: true })
  try {
    const plan = await legacy.read()
    expect(plan.rows.flatMap((row) => row.intervals).every((interval) => interval.entry === undefined)).toBe(true)
    expect(
      (await legacy.post("/api/entries/describe", { planId: plan.planId, source: "clockify", entryId: "existing-0" }))
        .status
    ).toBe(409)
  } finally {
    await legacy.web.dispose()
  }
})

it.each<SavedEntry["source"]>(["jira", "clockify"])(
  "updates a fully logged %s entry without creates and retains the next expected snapshot",
  async (source) => {
    const app = await makeApplication({
      fake: {
        transcripts: { "repo/morning.jsonl": transcript("morning", 10) },
        jiraWorklogs: { "PROJ-5662": [{ started: at(10), timeSpentSeconds: 3900 }] }
      }
    })
    try {
      const plan = await app.read()
      const entry = entryFor(plan, source)
      expect(plan.rows.find((row) => row.ticketKey === entry.ticketKey)?.proposal).toBeUndefined()
      const generated = await app.post("/api/entries/describe", identity(plan, entry))
      expect(generated.status).toBe(200)
      expect(await generated.json()).toMatchObject({
        sessionCount: 1,
        note: source === "clockify" ? `[PROJ-5662] ${summary}` : summary
      })
      expect(app.calls.updates).toHaveLength(0)
      const description = `${source === "clockify" ? "[PROJ-5662] " : ""}  Exact\n${"long ".repeat(150)}  `
      const payload = {
        ...edit(plan, entry, description),
        startMs: entry.startMs + 60000,
        endMs: entry.endMs + 120000,
        expected: { id: "forged" }
      }
      const response = await app.post("/api/entries/update", payload)
      expect(response.status).toBe(200)
      const first = await Schema.decodeUnknownPromise(UpdateSavedEntryResponse)(await response.json())
      expect(first.entry.description).toBe(description)
      expect(app.calls.updates[0]?.expected).toEqual(entry)
      const retainedAfterSave = (await app.retained()).plan
      expect(retainedAfterSave).not.toBeNull()
      const savedInterval = retainedAfterSave?.rows.flatMap((row) => row.intervals).find((interval) =>
        interval.entry?.source === source && interval.entry.id === entry.id
      )
      expect(savedInterval).toMatchObject({ startMs: payload.startMs, endMs: payload.endMs, entry: first.entry })
      const second = await app.post("/api/entries/update", edit(plan, first.entry, `${description}again`))
      expect(second.status).toBe(200)
      expect(app.calls.updates[1]?.expected).toEqual(first.entry)
      expect(
        (await app.retained()).plan?.rows.flatMap((row) => row.intervals).find((interval) =>
          interval.entry?.source === source && interval.entry.id === entry.id
        )?.entry?.description
      ).toBe(`${description}again`)
      expect(app.fake.world.createdClockifyEntries).toHaveLength(0)
      expect(app.fake.world.jiraWorklogs).toHaveLength(0)
      expect(app.fake.world.updatedClockifyEntries).toHaveLength(source === "clockify" ? 2 : 0)
      expect(app.fake.world.updatedJiraWorklogs).toHaveLength(source === "jira" ? 2 : 0)
    } finally {
      await app.web.dispose()
    }
  }
)

it("validates ranges/descriptions and preserves the plan when the provider refuses an edit", async () => {
  const app = await makeApplication()
  try {
    const plan = await app.read()
    const entry = entryFor(plan, "clockify")
    const payload = edit(plan, entry)
    for (
      const invalid of [{ endMs: entry.startMs }, { endMs: entry.startMs + 86400001 }, {
        startMs: Date.parse("2026-10-01"),
        endMs: Date.parse("2026-10-02")
      }]
    ) {
      expect((await app.post("/api/entries/update", { ...payload, ...invalid })).status).toBe(422)
    }
    expect((await app.post("/api/entries/update", { ...payload, description: "x".repeat(32001) })).status).toBe(400)
    expect((await app.post("/api/entries/update", { ...payload, startMs: 1.5 })).status).toBe(400)
    const weekStart = new Date(`${monday}T00:00:00`).getTime()
    expect(
      (await app.post("/api/entries/update", {
        ...edit(plan, entryFor(plan, "jira")),
        startMs: weekStart - 3600000,
        endMs: weekStart + 3600000
      })).status
    ).toBe(422)
    expect(app.calls.updates).toHaveLength(0)
    const failures: ReadonlyArray<readonly [SavedEntries.SavedEntryError["reason"], number]> = [["validation", 422], [
      "conflict",
      409
    ], ["provider", 500]]
    for (const [failure, status] of failures) {
      app.calls.failure = failure
      const response = await app.post("/api/entries/update", { ...payload, description: "changed" })
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ message: `test ${failure}` })
      expect((await app.retained()).plan).toEqual(plan)
    }
  } finally {
    await app.web.dispose()
  }
})

it("projects midnight slices and description-driven ticket changes without refreshing providers", async () => {
  const start = new Date(2026, 8, 7, 23).toISOString()
  const end = new Date(2026, 8, 8, 1).toISOString()
  const app = await makeApplication({
    fake: { clockifyEntries: [{ description: "[PROJ-5662] Overnight", start, end }] }
  })
  try {
    const plan = await app.read()
    const entry = entryFor(plan, "clockify", Date.parse(start))
    expect(plan.rows.flatMap((row) => row.intervals).filter((interval) => interval.entry?.source === "clockify"))
      .toHaveLength(2)
    expect(entry).toMatchObject({ startMs: Date.parse(start), endMs: Date.parse(end) })
    const response = await app.post("/api/entries/update", {
      ...edit(plan, entry, "[PROJ-5777] Moved work"),
      startMs: Date.parse(start) + 1800000,
      endMs: Date.parse(end) + 1800000
    })
    expect(response.status).toBe(200)
    const saved = await Schema.decodeUnknownPromise(UpdateSavedEntryResponse)(await response.json())
    const retained = (await app.retained()).plan
    const moved = retained?.rows.filter((row) => row.ticketKey === "PROJ-5777")
    expect(moved?.map((row) => [row.day, row.clockifySeconds])).toEqual([["2026-09-07", 1800], ["2026-09-08", 5400]])
    expect(
      moved?.flatMap((row) => row.intervals).filter((interval) => interval.source === "clockify").every((interval) =>
        interval.entry?.description === saved.entry.description
      )
    ).toBe(true)
    expect((await app.post("/api/entries/update", edit(plan, saved.entry, "Unlinked exact description"))).status).toBe(
      200
    )
    expect((await app.retained()).plan?.unlinkedClockify.map((slice) => [slice.seconds, slice.description])).toEqual([[
      1800,
      "Unlinked exact description"
    ], [5400, "Unlinked exact description"]])
    expect(app.fake.world.updatedClockifyEntries).toHaveLength(2)
    expect(app.fake.world.transcriptReads).toHaveLength(3)
  } finally {
    await app.web.dispose()
  }
})

it("generates from individually overlapping retained sessions, preserving provider ticket context and allowing repeated Generate", async () => {
  let answer: string | null = null
  const app = await makeApplication({ fake: { describer: () => answer } })
  try {
    const plan = await app.read()
    const reads = app.fake.world.transcriptReads.length
    const clockify = entryFor(plan, "clockify")
    const jira = entryFor(plan, "jira")
    const request = identity(plan, clockify)
    const first = await app.post("/api/entries/describe", request)
    expect(await Schema.decodeUnknownPromise(DescribeSavedEntryResponse)(await first.json())).toEqual({
      ...request,
      note: null,
      sessionCount: 1
    })
    answer = summary
    const second = await app.post("/api/entries/describe", request)
    expect(await second.json()).toEqual({ ...request, note: `[PROJ-5662] ${summary}`, sessionCount: 1 })
    const jiraRequest = identity(plan, jira)
    expect(await (await app.post("/api/entries/describe", jiraRequest)).json()).toEqual({
      ...jiraRequest,
      note: summary,
      sessionCount: 1
    })
    const unkeyed = plan.unlinkedClockify[0]?.entry
    expect(unkeyed).toBeDefined()
    if (unkeyed === undefined) return
    const unkeyedRequest = identity(plan, unkeyed)
    expect(await (await app.post("/api/entries/describe", unkeyedRequest)).json()).toEqual({
      ...unkeyedRequest,
      note: summary,
      sessionCount: 1
    })
    expect(app.fake.world.describeRequests.at(-1)?.ticketKey).toBeNull()
    const unmatched = identity(plan, entryFor(plan, "clockify", Date.parse(at(20))))
    expect(await (await app.post("/api/entries/describe", unmatched)).json()).toEqual({
      ...unmatched,
      note: null,
      sessionCount: 0
    })
    expect(app.fake.world.describeRequests).toHaveLength(4)
    expect(app.fake.world.transcriptReads).toHaveLength(reads)
    expect(app.calls.updates).toHaveLength(0)
    expect(app.fake.world.createdClockifyEntries).toHaveLength(0)
    expect(app.fake.world.jiraWorklogs).toHaveLength(0)
  } finally {
    await app.web.dispose()
  }
})

it("reports agent failure separately from no trustworthy session match", async () => {
  const app = await makeApplication({ fake: { describer: () => "fail" } })
  try {
    const plan = await app.read()
    const response = await app.post("/api/entries/describe", identity(plan, entryFor(plan, "clockify")))
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      _tag: "ApiError",
      message: expect.stringContaining("generation failed")
    })
    expect(app.calls.updates).toHaveLength(0)
  } finally {
    await app.web.dispose()
  }
})

it("returns no generated note for ambiguous unkeyed sessions or a provider-only retained week", async () => {
  const app = await makeApplication({
    fake: {
      transcripts: {
        "repo/one.jsonl": transcript("one", 10),
        "repo/two.jsonl": transcript("two", 10, "PROJ-5777")
      }
    }
  })
  try {
    const recorded = await readWeekStream(await app.get(`/api/week/recorded-only?monday=${monday}`), () => {})
    expect(recorded.sessionScanAvailable).toBe(false)
    expect(await (await app.post("/api/entries/describe", identity(recorded, entryFor(recorded, "clockify")))).json())
      .toMatchObject({ note: null, sessionCount: 0 })
    expect(app.fake.world.transcriptReads).toHaveLength(0)
    const scanned = await app.read()
    const unkeyed = scanned.unlinkedClockify[0]?.entry
    expect(unkeyed).toBeDefined()
    if (unkeyed === undefined) return
    expect(await (await app.post("/api/entries/describe", identity(scanned, unkeyed))).json()).toMatchObject({
      note: null,
      sessionCount: 0
    })
    expect(app.fake.world.describeRequests).toHaveLength(0)
    expect(app.calls.updates).toHaveLength(0)
  } finally {
    await app.web.dispose()
  }
})

it.each(["settings", "entry", "plan"])("rejects a generated result crossing a %s change", async (change) => {
  const entered = await Effect.runPromise(Deferred.make<void>())
  const release = await Effect.runPromise(Deferred.make<void>())
  const app = await makeApplication({
    beforeDescribe: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
  })
  try {
    const plan = await app.read()
    const entry = entryFor(plan, "clockify")
    const pending = app.post("/api/entries/describe", identity(plan, entry))
    await Effect.runPromise(Deferred.await(entered))
    if (change === "settings") {
      await app.post("/api/config/agent", { provider: "codex", model: null, effort: null })
      await app.post("/api/config/agent", { provider: "claude", model: null, effort: null })
    } else if (change === "entry") {
      expect((await app.post("/api/entries/update", edit(plan, entry, "[PROJ-5662] Edited"))).status).toBe(200)
    } else {
      await app.read()
    }
    await Effect.runPromise(Deferred.succeed(release, undefined))
    expect((await pending).status).toBe(change === "settings" ? 500 : 409)
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await app.web.dispose()
  }
})

it("does not let an earlier provider refresh overwrite a successful update", async () => {
  const entered = await Effect.runPromise(Deferred.make<void>())
  const release = await Effect.runPromise(Deferred.make<void>())
  const app = await makeApplication({
    afterRefresh: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
  })
  try {
    const plan = await app.read()
    const entry = entryFor(plan, "clockify")
    const refresh = app.get(`/api/week/recorded?planId=${plan.planId}`).then((response) =>
      readWeekStream(response, () => {})
    )
    await Effect.runPromise(Deferred.await(entered))
    expect((await app.post("/api/entries/update", edit(plan, entry, "[PROJ-5662] Saved during refresh"))).status).toBe(
      200
    )
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await expect(refresh).rejects.toThrow("Retry Refresh totals")
    const retained = (await app.retained()).plan
    expect(retained).not.toBeNull()
    if (retained === null) return
    const current = entryFor(retained, "clockify")
    expect(current.description).toBe("[PROJ-5662] Saved during refresh")
    expect((await app.post("/api/entries/update", edit(plan, current, "[PROJ-5662] Next"))).status).toBe(200)
    expect(app.calls.updates[1]?.expected.description).toBe("[PROJ-5662] Saved during refresh")
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await app.web.dispose()
  }
})

it("rejects a second stale draft before provider access and permits the returned revision", async () => {
  const app = await makeApplication()
  try {
    const plan = await app.read()
    const entry = entryFor(plan, "clockify")
    const staleDraft = edit(plan, entry, "[PROJ-5662] Editor two")
    const response = await app.post("/api/entries/update", {
      ...edit(plan, entry, "[PROJ-5662] Editor one"),
      startMs: entry.startMs + 60000,
      endMs: entry.endMs + 60000
    })
    expect(response.status).toBe(200)
    const saved = await Schema.decodeUnknownPromise(UpdateSavedEntryResponse)(await response.json())
    expect(saved.entry.revision).not.toBe(entry.revision)
    expect((await app.post("/api/entries/update", staleDraft)).status).toBe(409)
    expect(app.calls.updates).toHaveLength(1)
    expect(app.fake.world.updatedClockifyEntries).toHaveLength(1)
    const retained = (await app.retained()).plan
    expect(retained?.rows.flatMap((row) => row.intervals).find((interval) => interval.entry?.id === entry.id)?.entry)
      .toEqual(saved.entry)
    expect((await app.post("/api/entries/update", edit(plan, saved.entry, "[PROJ-5662] Reviewed again"))).status).toBe(
      200
    )
    expect(app.calls.updates).toHaveLength(2)
    expect(app.fake.world.updatedClockifyEntries).toHaveLength(2)
    // Editing this entry must not expire drafts of an unrelated entry in the same week.
    expect(
      (await app.post(
        "/api/entries/update",
        edit(plan, entryFor(plan, "clockify", Date.parse(at(20))), "[PROJ-5662] Evening reviewed")
      )).status
    ).toBe(200)
  } finally {
    await app.web.dispose()
  }
})

it("rejects a full scan captured before an edit and accepts a scan started afterward", async () => {
  const entered = await Effect.runPromise(Deferred.make<void>())
  const release = await Effect.runPromise(Deferred.make<void>())
  const gate = { enabled: false }
  const app = await makeApplication({
    afterScan: () =>
      gate.enabled
        ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
        : Effect.void
  })
  try {
    const plan = await app.read()
    const entry = entryFor(plan, "clockify")
    gate.enabled = true
    const scan = app.get(`/api/week/?monday=${monday}`)
    await Effect.runPromise(Deferred.await(entered))
    const response = await app.post("/api/entries/update", edit(plan, entry, "[PROJ-5662] Saved during scan"))
    expect(response.status).toBe(200)
    const saved = await Schema.decodeUnknownPromise(UpdateSavedEntryResponse)(await response.json())
    await Effect.runPromise(Deferred.succeed(release, undefined))
    const rejected = await scan
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({
      _tag: "PlanExpiredError",
      message: expect.stringContaining("Retry the week read")
    })
    const retained = (await app.retained()).plan
    expect(retained?.planId).toBe(plan.planId)
    expect(retained?.rows.flatMap((row) => row.intervals).find((interval) => interval.entry?.id === entry.id)?.entry)
      .toEqual(saved.entry)
    gate.enabled = false
    const current = await app.read()
    expect(current.planId).not.toBe(plan.planId)
    expect(entryFor(current, "clockify").description).toBe(saved.entry.description)
    expect(app.fake.world.updatedClockifyEntries).toHaveLength(1)
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await app.web.dispose()
  }
})

it("preserves unchanged revisions across refresh and expires snapshots changed at the provider", async () => {
  const app = await makeApplication()
  try {
    const plan = await app.read()
    const old = entryFor(plan, "clockify")
    const refreshed = await readWeekStream(await app.get(`/api/week/recorded?planId=${plan.planId}`), () => {})
    const current = entryFor(refreshed, "clockify")
    expect(current.revision).toBe(old.revision)
    const accepted = await app.post("/api/entries/update", edit(plan, old, "[PROJ-5662] Draft remained current"))
    expect(accepted.status).toBe(200)
    const saved = await Schema.decodeUnknownPromise(UpdateSavedEntryResponse)(await accepted.json())
    await Effect.runPromise(
      Effect.gen(function*() {
        const service = yield* SavedEntries.SavedEntries
        return yield* service.update({
          expected: saved.entry,
          startMs: saved.entry.startMs,
          endMs: saved.entry.endMs,
          description: `${saved.entry.description} `
        })
      }).pipe(Effect.provide(app.fake.layer))
    )
    const changed = await readWeekStream(await app.get(`/api/week/recorded?planId=${plan.planId}`), () => {})
    const external = entryFor(changed, "clockify")
    expect(external.revision).not.toBe(saved.entry.revision)
    expect(external.description).toBe(`${saved.entry.description} `)
    expect(
      (await app.post("/api/entries/update", edit(plan, saved.entry, "[PROJ-5662] Stale after external edit"))).status
    ).toBe(409)
    expect(app.calls.updates).toHaveLength(1)
    expect((await app.post("/api/entries/update", edit(changed, external, "[PROJ-5662] Fresh after refresh"))).status)
      .toBe(200)
  } finally {
    await app.web.dispose()
  }
})
