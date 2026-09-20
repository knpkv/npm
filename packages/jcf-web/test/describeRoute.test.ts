import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { ConfigService, IssueFacts, ReconcileService } from "@knpkv/jira-clockify"
import type { SessionAgentSettings } from "@knpkv/jira-clockify/agent/agentSettings.js"
import { FAKE_HOME, type FakeHeadlessOptions, makeFakeHeadless } from "@knpkv/jira-clockify/testing.js"
import { Deferred, Effect, Layer, Redacted, Schema } from "effect"
import { Etag, HttpPlatform, HttpRouter } from "effect/unstable/http"
import { readWeekStream } from "../src/client/api.js"
import { application } from "../src/server/HttpApplication.js"
import { makeOwnerSessionSecrets, ownerSessionCookie, OwnerSessionSecrets } from "../src/server/OwnerSession.js"
import { DescribeRowResponse, WeekPlan } from "../src/shared/contracts.js"
import type { ConfirmPayload, DescribeRowRequest, ManualPayload } from "../src/shared/contracts.js"

// HTTP composition boundary over isolated engine fixtures; no real agent or provider calls.
// @effect-diagnostics strictEffectProvide:off
const origin = "http://127.0.0.1:4179"
const monday = "2026-09-07"
const note = "Implemented weekly review and tested approval behavior"
const claude: SessionAgentSettings = { provider: "claude", model: null, effort: null }
const codex: SessionAgentSettings = { provider: "codex", model: "test-codex", effort: "high" }
type RoutePayload =
  | SessionAgentSettings
  | Schema.Schema.Type<typeof ConfirmPayload>
  | Schema.Schema.Type<typeof ManualPayload>
  | Omit<DescribeRowRequest, "rowId">

/** Real HTTP/engine path with an optional gate immediately before description generation. */
const makeApplication = async (
  describer: FakeHeadlessOptions["describer"] = () => note,
  beforeDescribe: () => Effect.Effect<void> = () => Effect.void,
  beforeRefresh: () => Effect.Effect<void> = () => Effect.void
) => {
  const secrets = await Effect.runPromise(makeOwnerSessionSecrets(origin).pipe(Effect.provide(NodeCrypto.layer)))
  const fake = makeFakeHeadless({
    config: { sessionRoots: [`${FAKE_HOME}/dev/work`], sessionOwnership: "any" },
    issueSummaries: { "PROJ-5662": "Weekly approval review" },
    describer,
    transcripts: {
      "repo/session.jsonl": Array.from({ length: 61 }, (_, minute) =>
        JSON.stringify({
          cwd: `${FAKE_HOME}/dev/work/repo`,
          gitBranch: "feature/PROJ-5662",
          isSidechain: false,
          message: { content: "Implemented approval queue with Undo", role: "user" },
          sessionId: "session-a",
          timestamp: new Date(2026, 8, 7, 10, minute).toISOString(),
          type: "user",
          uuid: `prompt-${minute}`,
          version: "9.9.9"
        })).join("\n")
    }
  })
  const calls = { describe: 0, ownership: 0, refresh: 0, settings: new Array<SessionAgentSettings>() }
  const engine = Layer.effect(
    ReconcileService.ReconcileService,
    Effect.gen(function*() {
      const original = yield* ReconcileService.ReconcileService
      const config = yield* ConfigService.ConfigService
      return ReconcileService.ReconcileService.of({
        ...original,
        describeProposals: (options) =>
          Effect.gen(function*() {
            calls.describe++
            yield* beforeDescribe()
            calls.settings.push((yield* config.get).sessionAgent)
            return yield* original.describeProposals(options)
          }),
        refreshRecordedTime: (period, previous) =>
          Effect.sync(() => calls.refresh++).pipe(
            Effect.andThen(beforeRefresh()),
            Effect.andThen(original.refreshRecordedTime(period, previous))
          )
      })
    })
  ).pipe(Layer.provide(fake.layer))
  const issues = Layer.effect(
    IssueFacts.IssueFacts,
    Effect.gen(function*() {
      const original = yield* IssueFacts.IssueFacts
      return IssueFacts.IssueFacts.of({
        lookup: (keys) => Effect.sync(() => calls.ownership++).pipe(Effect.andThen(original.lookup(keys)))
      })
    })
  ).pipe(Layer.provide(fake.layer))
  const app = application.pipe(
    Layer.provide(engine),
    Layer.provide(issues),
    Layer.provide(fake.layer),
    Layer.provideMerge(Layer.succeed(OwnerSessionSecrets, secrets)),
    Layer.provide(Etag.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(HttpPlatform.layer.pipe(Layer.provide(NodeServices.layer)))
  )
  const web = HttpRouter.toWebHandler(app, { disableLogger: true })
  const get = (path: string) =>
    web.handler(new Request(`${origin}${path}`, { headers: { cookie: ownerSessionCookie(secrets) } }))
  const post = (path: string, body: RoutePayload, auth: "owner" | "no-csrf" | "none" = "owner") =>
    web.handler(
      new Request(`${origin}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth !== "none" && { cookie: ownerSessionCookie(secrets) }),
          ...(auth === "owner" && { origin, "x-csrf-token": Redacted.value(secrets.csrfToken) })
        },
        body: JSON.stringify(body)
      })
    )
  const read = async (day = monday) => {
    const response = await get(`/api/week/?monday=${day}`)
    expect(response.status).toBe(200)
    return Schema.decodeUnknownPromise(Schema.toCodecJson(WeekPlan))(await response.json())
  }
  const describe = async (request: { readonly planId: string; readonly rowId: string }) => {
    const response = await post("/api/rows/describe", request)
    expect(response.status).toBe(200)
    return Schema.decodeUnknownPromise(DescribeRowResponse)(await response.json())
  }
  return { web, fake, calls, post, get, read, describe }
}

it("authenticates descriptions, uses retained row evidence, and leaves confirmation edits authoritative", async () => {
  const app = await makeApplication()
  try {
    const plan = await app.read()
    const row = plan.rows.find((entry) => entry.proposal !== undefined)
    expect(row).toBeDefined()
    expect(row?.ticketTitle).toBe("Weekly approval review")
    const request = { planId: plan.planId, rowId: row?.rowId ?? "missing" }
    const before = { reads: app.fake.world.transcriptReads.length, ownership: app.calls.ownership }
    expect(app.calls.describe).toBe(0)
    expect((await app.post("/api/rows/describe", request, "none")).status).toBe(401)
    expect((await app.post("/api/rows/describe", request, "no-csrf")).status).toBe(403)
    expect((await app.post("/api/rows/describe", { planId: plan.planId })).status).toBe(400)
    expect((await app.post("/api/rows/describe", { ...request, rowId: "unknown" })).status).toBe(409)
    expect((await app.post("/api/rows/describe", { ...request, planId: "unknown" })).status).toBe(409)
    expect(app.calls.describe).toBe(0)
    expect(await app.describe(request)).toEqual({ ...request, note })
    expect(await app.describe(request)).toEqual({ ...request, note })
    expect(app.calls.describe).toBe(1)
    expect(app.fake.world.describeRequests).toEqual([{
      ticketKey: row?.ticketKey,
      summary: row?.ticketTitle,
      digest: expect.stringContaining("Implemented approval queue with Undo")
    }])
    expect(app.fake.world.transcriptReads).toHaveLength(before.reads)
    expect(app.calls.ownership).toBe(before.ownership)
    expect(app.fake.world.createdClockifyEntries).toHaveLength(0)
    expect(app.fake.world.jiraWorklogs).toHaveLength(0)
    const written = await app.post("/api/rows/confirm", { ...request, note: "My edited description" })
    expect(written.status).toBe(200)
    expect(await written.json()).toMatchObject({ description: expect.stringContaining("My edited description") })
    expect(app.calls.describe).toBe(1)
  } finally {
    await app.web.dispose()
  }
})

it.each([note, null])("coalesces concurrent requests and caches %s across a totals refresh", async (answer) => {
  const entered = await Effect.runPromise(Deferred.make<void>())
  const release = await Effect.runPromise(Deferred.make<void>())
  const app = await makeApplication(
    () => answer,
    () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
  )
  try {
    const plan = await app.read()
    const request = { planId: plan.planId, rowId: plan.rows[0]?.rowId ?? "missing" }
    const pending = Promise.all(Array.from({ length: 5 }, () => app.describe(request)))
    await Effect.runPromise(Deferred.await(entered))
    expect(app.calls.describe).toBe(1)
    await Effect.runPromise(Deferred.succeed(release, undefined))
    expect(await pending).toEqual(Array.from({ length: 5 }, () => ({ ...request, note: answer })))
    await readWeekStream(await app.get(`/api/week/recorded?planId=${plan.planId}`), () => {})
    expect(await app.describe(request)).toEqual({ ...request, note: answer })
    expect(app.calls.describe).toBe(1)
    expect(app.fake.world.transcriptReads).toHaveLength(1)
    expect(app.fake.world.createdClockifyEntries).toHaveLength(0)
    expect(app.fake.world.jiraWorklogs).toHaveLength(0)
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await app.web.dispose()
  }
})

it("describes evidence that becomes proposable after a running timer stops", async () => {
  const app = await makeApplication()
  try {
    app.fake.world.runningTimer = {
      description: "[PROJ-5662] Running work",
      start: new Date(2026, 8, 7, 9).toISOString()
    }
    const excluded = await app.read()
    expect(excluded.excludedDays.map(({ day }) => day)).toContain(monday)
    expect(excluded.rows).toEqual([])

    app.fake.world.runningTimer = null
    const refreshed = await readWeekStream(
      await app.get(`/api/week/recorded?planId=${excluded.planId}`),
      () => {}
    )
    const row = refreshed.rows.find((entry) => entry.proposal !== undefined)
    expect(row).toBeDefined()
    const request = { planId: refreshed.planId, rowId: row?.rowId ?? "missing" }
    expect(await app.describe(request)).toEqual({ ...request, note })
    expect(app.calls.describe).toBe(1)
  } finally {
    await app.web.dispose()
  }
})

it("retries a transient description failure instead of caching its null fallback", async () => {
  let attempt = 0
  const app = await makeApplication(() => attempt++ === 0 ? "fail" : note)
  try {
    const plan = await app.read()
    const request = { planId: plan.planId, rowId: plan.rows[0]?.rowId ?? "missing" }
    const failed = await app.post("/api/rows/describe", request)
    expect(failed.status).not.toBe(200)
    expect(await app.describe(request)).toEqual({ ...request, note })
    expect(app.calls.describe).toBe(2)
  } finally {
    await app.web.dispose()
  }
})

it("serializes concurrent confirmations around their live tally and writes one row once", async () => {
  const entered = await Effect.runPromise(Deferred.make<void>())
  const release = await Effect.runPromise(Deferred.make<void>())
  const app = await makeApplication(
    () => note,
    () => Effect.void,
    () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
  )
  try {
    const plan = await app.read()
    const request = { planId: plan.planId, rowId: plan.rows[0]?.rowId ?? "missing" }
    const responses = Promise.all([
      app.post("/api/rows/confirm", request),
      app.post("/api/rows/confirm", request)
    ])
    await Effect.runPromise(Deferred.await(entered))
    expect(app.calls.refresh).toBe(1)
    expect(app.fake.world.createdClockifyEntries).toEqual([])
    await Effect.runPromise(Deferred.succeed(release, undefined))

    expect((await responses).map((response) => response.status)).toEqual([200, 200])
    expect(app.calls.refresh).toBe(2)
    expect(app.fake.world.createdClockifyEntries).toHaveLength(1)
    expect(app.fake.world.jiraWorklogs).toHaveLength(1)
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await app.web.dispose()
  }
})

it("keeps manual writes outside a confirmation's live-tally critical section", async () => {
  const entered = await Effect.runPromise(Deferred.make<void>())
  const release = await Effect.runPromise(Deferred.make<void>())
  const app = await makeApplication(
    () => note,
    () => Effect.void,
    () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
  )
  try {
    const plan = await app.read()
    const confirm = app.post("/api/rows/confirm", {
      planId: plan.planId,
      rowId: plan.rows[0]?.rowId ?? "missing"
    })
    await Effect.runPromise(Deferred.await(entered))
    const manual = app.post("/api/rows/manual", {
      day: monday,
      seconds: 3600,
      ticketKey: "PROJ-5662"
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(app.fake.world.createdClockifyEntries).toEqual([])
    expect(app.fake.world.jiraWorklogs).toEqual([])
    await Effect.runPromise(Deferred.succeed(release, undefined))
    expect((await confirm).status).toBe(200)
    expect((await manual).status).toBe(200)
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await app.web.dispose()
  }
})

it("rejects a sub-minute Jira manual write before touching either provider", async () => {
  const app = await makeApplication()
  try {
    const rejected = await app.post("/api/rows/manual", {
      day: monday,
      seconds: 30,
      ticketKey: "PROJ-5662"
    })
    expect(rejected.status).toBe(422)
    expect(app.fake.world.createdClockifyEntries).toEqual([])
    expect(app.fake.world.jiraWorklogs).toEqual([])

    const clockifyOnly = await app.post("/api/rows/manual", {
      day: monday,
      seconds: 30,
      targets: { clockify: true, jira: false },
      ticketKey: "PROJ-5662"
    })
    expect(clockifyOnly.status).toBe(200)
    const created = app.fake.world.createdClockifyEntries[0]
    expect(created?.end === undefined ? undefined : new Date(created.end).getTime() - new Date(created.start).getTime())
      .toBe(30_000)
    expect(app.fake.world.jiraWorklogs).toEqual([])

    const oneMinute = await app.post("/api/rows/manual", {
      day: monday,
      seconds: 60,
      ticketKey: "PROJ-5662"
    })
    expect(oneMinute.status).toBe(200)
    expect(app.fake.world.jiraWorklogs[0]?.timeSpentSeconds).toBe(60)
  } finally {
    await app.web.dispose()
  }
})

it.each(["24:00", "12:60", "99:99"])(
  "rejects invalid manual clock %s before touching providers",
  async (startClock) => {
    const app = await makeApplication()
    try {
      const response = await app.post("/api/rows/manual", {
        day: monday,
        seconds: 1800,
        startClock,
        ticketKey: "PROJ-5662"
      })
      expect(response.status).toBe(400)
      expect(app.fake.world.createdClockifyEntries).toEqual([])
      expect(app.fake.world.jiraWorklogs).toEqual([])
    } finally {
      await app.web.dispose()
    }
  }
)

it.each(["00:00", "23:59"])("accepts manual clock boundary %s", async (startClock) => {
  const app = await makeApplication()
  try {
    const response = await app.post("/api/rows/manual", {
      day: monday,
      seconds: 60,
      startClock,
      ticketKey: "PROJ-5662"
    })
    expect(response.status).toBe(200)
    const started = new Date(app.fake.world.createdClockifyEntries[0]?.start ?? 0)
    const [hour, minute] = startClock.split(":").map(Number)
    expect(started.getHours()).toBe(hour)
    expect(started.getMinutes()).toBe(minute)
    expect(app.fake.world.jiraWorklogs).toHaveLength(1)
  } finally {
    await app.web.dispose()
  }
})

it("rechecks a running timer before confirming retained evidence", async () => {
  const app = await makeApplication()
  try {
    const plan = await app.read()
    const request = { planId: plan.planId, rowId: plan.rows[0]?.rowId ?? "missing" }
    app.fake.world.runningTimer = {
      description: "[PROJ-5662] Running work",
      start: new Date(2026, 8, 7, 9).toISOString()
    }

    const blocked = await app.post("/api/rows/confirm", request)
    expect(blocked.status).toBe(422)
    expect(await blocked.text()).toContain("timer is still running")
    expect(app.fake.world.createdClockifyEntries).toEqual([])
    expect(app.fake.world.jiraWorklogs).toEqual([])

    app.fake.world.runningTimer = null
    expect((await app.post("/api/rows/confirm", request)).status).toBe(200)
    expect(app.fake.world.createdClockifyEntries).toHaveLength(1)
    expect(app.fake.world.jiraWorklogs).toHaveLength(1)
  } finally {
    await app.web.dispose()
  }
})

it("refuses browser writes while jcf watch owns the machine writer guard", async () => {
  const app = await makeApplication()
  try {
    const plan = await app.read()
    app.fake.world.writtenFiles[`${FAKE_HOME}/.jcf/watch.lease`] = JSON.stringify({
      owner: "watch-owner",
      heldSinceMs: Date.now(),
      refreshedAtMs: Date.now(),
      intervalSeconds: 300
    })
    const response = await app.post("/api/rows/confirm", {
      planId: plan.planId,
      rowId: plan.rows[0]?.rowId ?? "missing"
    })
    expect(response.status).toBe(422)
    expect(await response.text()).toContain("jcf watch is writing time")
    expect(app.fake.world.createdClockifyEntries).toEqual([])
    expect(app.fake.world.jiraWorklogs).toEqual([])
  } finally {
    await app.web.dispose()
  }
})

it("changes the cache identity for provider, model, and effort", async () => {
  const app = await makeApplication()
  try {
    const plan = await app.read()
    const request = { planId: plan.planId, rowId: plan.rows[0]?.rowId ?? "missing" }
    await app.describe(request)
    for (
      const settings of [codex, { ...codex, model: "another-model" }, {
        ...codex,
        effort: "low"
      }] satisfies ReadonlyArray<SessionAgentSettings>
    ) {
      expect((await app.post("/api/config/agent", settings)).status).toBe(200)
      await app.describe(request)
      await app.describe(request)
    }
    expect(app.calls.settings).toEqual([claude, codex, { ...codex, model: "another-model" }, {
      ...codex,
      effort: "low"
    }])
    expect(app.calls.describe).toBe(4)
  } finally {
    await app.web.dispose()
  }
})

it.each([false, true])(
  "rejects a pending result crossing settings changes, including change-back=%s",
  async (changeBack) => {
    const entered = await Effect.runPromise(Deferred.make<void>())
    const release = await Effect.runPromise(Deferred.make<void>())
    const app = await makeApplication(
      () => note,
      () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
    )
    try {
      const plan = await app.read()
      const request = { planId: plan.planId, rowId: plan.rows[0]?.rowId ?? "missing" }
      const pending = app.post("/api/rows/describe", request)
      await Effect.runPromise(Deferred.await(entered))
      expect((await app.post("/api/config/agent", codex)).status).toBe(200)
      if (changeBack) {
        expect((await app.post("/api/config/agent", claude)).status).toBe(200)
      }
      await Effect.runPromise(Deferred.succeed(release, undefined))
      const stale = await pending
      expect(stale.status).toBe(500)
      expect(await stale.json()).toMatchObject({
        _tag: "ApiError",
        message: expect.stringContaining("settings changed")
      })
      expect(await app.describe(request)).toEqual({ ...request, note })
      await app.describe(request)
      expect(app.calls.describe).toBe(2)
      expect(app.calls.settings.at(-1)).toEqual(changeBack ? claude : codex)
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined))
      await app.web.dispose()
    }
  }
)

it("evicts descriptions with replaced and expired plans", async () => {
  const app = await makeApplication()
  try {
    const first = await app.read()
    const request = { planId: first.planId, rowId: first.rows[0]?.rowId ?? "missing" }
    await app.describe(request)
    const replacement = await app.read()
    expect(replacement.planId).not.toBe(first.planId)
    expect((await app.post("/api/rows/describe", request)).status).toBe(409)
    await app.describe({ ...request, planId: replacement.planId })
    expect(app.calls.describe).toBe(2)
    for (const day of ["2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19"]) {
      await app.read(day)
    }
    expect((await app.post("/api/rows/describe", { ...request, planId: replacement.planId })).status).toBe(409)
    expect(app.calls.describe).toBe(2)
  } finally {
    await app.web.dispose()
  }
})
