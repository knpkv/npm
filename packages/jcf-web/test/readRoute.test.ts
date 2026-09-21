import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { FAKE_HOME, makeFakeHeadless } from "@knpkv/jira-clockify/testing.js"
import { Effect, Layer, Redacted } from "effect"
import { Etag, HttpPlatform, HttpRouter } from "effect/unstable/http"
import { readWeekStream } from "../src/client/api.js"
import { decodeSavedWeek } from "../src/client/decoding.js"
import { application } from "../src/server/HttpApplication.js"
import {
  activateOwnerSessionBootstrap,
  makeOwnerSessionSecrets,
  ownerSessionCookie,
  OwnerSessionSecrets
} from "../src/server/OwnerSession.js"
import type { ReadProgress } from "../src/shared/contracts.js"

// This test is an HTTP application entry point over isolated provider fixtures.
// @effect-diagnostics strictEffectProvide:off
it("authenticates streamed reads and sends real engine stages before the retained plan", async () => {
  const secrets = await Effect.runPromise(
    makeOwnerSessionSecrets("http://127.0.0.1:4179").pipe(Effect.provide(NodeCrypto.layer))
  )
  const fake = makeFakeHeadless({
    config: { sessionRoots: [`${FAKE_HOME}/dev/work`] },
    clockifyEntries: [
      {
        description: "Team planning",
        start: new Date(2026, 8, 7, 9).toISOString(),
        end: new Date(2026, 8, 7, 9, 30).toISOString()
      },
      {
        description: "",
        start: new Date(2026, 8, 7, 23, 45).toISOString(),
        end: new Date(2026, 8, 8, 0, 15).toISOString()
      }
    ],
    attributor: () => ({ _tag: "Chosen", ticketKey: "PROJ-5662", confidence: 1 }),
    transcripts: {
      "repo/session.jsonl": Array.from({ length: 61 }, (_, minute) =>
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
    }
  })
  const app = application.pipe(
    Layer.provide(fake.layer),
    Layer.provideMerge(Layer.succeed(OwnerSessionSecrets, secrets)),
    Layer.provide(Etag.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(HttpPlatform.layer.pipe(Layer.provide(NodeServices.layer)))
  )
  const web = HttpRouter.toWebHandler(app, { disableLogger: true })
  try {
    // Bootstrap stays inactive until the composed application has successfully handled a request.
    const bootstrapRequest = () =>
      new Request("http://127.0.0.1:4179/auth/bootstrap", {
        method: "POST",
        headers: { origin: secrets.authorityOrigin, authorization: `Bearer ${Redacted.value(secrets.bootstrapToken)}` }
      })
    expect((await web.handler(bootstrapRequest())).status).toBe(401)
    await Effect.runPromise(activateOwnerSessionBootstrap(secrets))
    const bootstrap = await web.handler(bootstrapRequest())
    expect(bootstrap.status).toBe(200)
    expect(bootstrap.headers.get("set-cookie")).toBe(ownerSessionCookie(secrets))
    expect(await bootstrap.json()).toEqual({ csrfToken: Redacted.value(secrets.csrfToken) })
    expect((await web.handler(bootstrapRequest())).status).toBe(401)
    const url = "http://127.0.0.1:4179/api/week/stream?monday=2026-09-07&only=clockify"
    expect((await web.handler(new Request(url))).status).toBe(401)
    const crossOrigin = await web.handler(
      new Request(url, {
        headers: { cookie: ownerSessionCookie(secrets), "sec-fetch-site": "same-site" }
      })
    )
    expect(crossOrigin.status).toBe(403)
    expect(fake.world.attributorBatches).toHaveLength(0)
    expect(fake.world.transcriptReads).toHaveLength(0)
    const progress: Array<ReadProgress> = []
    const response = await web.handler(
      new Request(url, {
        headers: {
          cookie: ownerSessionCookie(secrets),
          origin: secrets.browserOrigin,
          "sec-fetch-site": "same-origin"
        }
      })
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/x-ndjson")
    const plan = await readWeekStream(response, (event) => progress.push(event))
    expect(plan.scope).toBe("clockify")
    expect(plan.sessionScanAvailable).toBe(true)
    // Unkeyed entries survive HTTP projection, including both sides of a midnight boundary.
    expect(plan.unlinkedClockify).toMatchObject([
      {
        day: "2026-09-07",
        seconds: 1800,
        description: "Team planning",
        startMs: new Date(2026, 8, 7, 9).getTime(),
        endMs: new Date(2026, 8, 7, 9, 30).getTime()
      },
      {
        day: "2026-09-07",
        seconds: 900,
        description: "",
        startMs: new Date(2026, 8, 7, 23, 45).getTime(),
        endMs: new Date(2026, 8, 8).getTime()
      },
      {
        day: "2026-09-08",
        seconds: 900,
        description: "",
        startMs: new Date(2026, 8, 8).getTime(),
        endMs: new Date(2026, 8, 8, 0, 15).getTime()
      }
    ])
    expect(plan.unlinkedClockify[1]?.entry).toEqual({
      revision: plan.planId,
      id: "existing-1",
      source: "clockify",
      ticketKey: null,
      description: "",
      startMs: new Date(2026, 8, 7, 23, 45).getTime(),
      endMs: new Date(2026, 8, 8, 0, 15).getTime()
    })
    expect(plan.unlinkedClockify[2]?.entry).toEqual(plan.unlinkedClockify[1]?.entry)
    expect(plan.rows.every((row) => row.ticketKey === "PROJ-5662")).toBe(true)
    expect([...new Set(progress.map((event) => event.stage))]).toEqual([
      "sessions",
      "attribution",
      "recorded",
      "issues",
      "calendar"
    ])
    expect(progress.find((event) => event.stage === "recorded")?.message).not.toContain("Jira")
    const savedUrl = "http://127.0.0.1:4179/api/week/saved?monday=2026-09-07&only=clockify"
    expect((await web.handler(new Request(savedUrl))).status).toBe(401)
    const saved = await web.handler(new Request(savedUrl, { headers: { cookie: ownerSessionCookie(secrets) } }))
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ monday: plan.monday, scope: "clockify", plan: { planId: plan.planId } })
    const missingScope = await web.handler(
      new Request(savedUrl.replace("only=clockify", "only=jira"), {
        headers: { cookie: ownerSessionCookie(secrets) }
      })
    )
    expect(await missingScope.json()).toMatchObject({ plan: null, scope: "jira" })
    expect(fake.world.attributorBatches).toHaveLength(1)
    expect(fake.world.transcriptReads).toHaveLength(1)
    const confirmed = await web.handler(
      new Request("http://127.0.0.1:4179/api/rows/confirm", {
        method: "POST",
        headers: { cookie: ownerSessionCookie(secrets), "content-type": "application/json" },
        body: JSON.stringify({ planId: plan.planId, rowId: "no-row" })
      })
    )
    expect(confirmed.status).toBe(403)
    const retained = await web.handler(
      new Request("http://127.0.0.1:4179/api/rows/confirm", {
        method: "POST",
        headers: {
          cookie: ownerSessionCookie(secrets),
          "content-type": "application/json",
          origin: "http://127.0.0.1:4179",
          "x-csrf-token": Redacted.value(secrets.csrfToken)
        },
        body: JSON.stringify({ planId: plan.planId, rowId: "no-row" })
      })
    )
    expect(retained.status).toBe(409)
    expect(await retained.text()).toContain("That row is not part of this week")
    expect(plan).toMatchObject({ sessionCount: 1, attributorCalls: 1 })
    expect(plan.unattributed).toEqual([])
    expect(plan.withheld).toEqual([])
    const row = plan.rows.find((entry) => entry.ticketKey === "PROJ-5662")
    expect(row?.proposal?.maxSeconds).toBeGreaterThan(0)
    const written = await web.handler(
      new Request("http://127.0.0.1:4179/api/rows/confirm", {
        method: "POST",
        headers: {
          cookie: ownerSessionCookie(secrets),
          "content-type": "application/json",
          origin: "http://127.0.0.1:4179",
          "x-csrf-token": Redacted.value(secrets.csrfToken)
        },
        body: JSON.stringify({ planId: plan.planId, rowId: row?.rowId })
      })
    )
    expect(written.status).toBe(200)
    expect(fake.world.createdClockifyEntries).toHaveLength(1)
    const refreshUrl = `http://127.0.0.1:4179/api/week/recorded?planId=${encodeURIComponent(plan.planId)}`
    expect((await web.handler(new Request(refreshUrl))).status).toBe(401)
    const updates: Array<ReadProgress> = []
    const refreshed = await readWeekStream(
      await web.handler(
        new Request(refreshUrl, {
          headers: { cookie: ownerSessionCookie(secrets) }
        })
      ),
      (event) => updates.push(event)
    )
    expect(refreshed.unlinkedClockify).toEqual(plan.unlinkedClockify)
    expect(refreshed.sessionScanAvailable).toBe(true)
    expect(updates.map((event) => event.stage)).toEqual(["recorded", "calendar"])
    expect(refreshed.rows.find((entry) => entry.ticketKey === "PROJ-5662")?.clockifySeconds).toBe(
      row?.proposal?.maxSeconds
    )
    expect(refreshed.rows.find((entry) => entry.ticketKey === "PROJ-5662")?.proposal).toBeUndefined()
    expect(fake.world.attributorBatches).toHaveLength(1)
    expect(fake.world.transcriptReads).toHaveLength(1)
    // HttpApi encodes an absent proposal as null. Restore must use its JSON codec too.
    const restoredResponse = await web.handler(
      new Request(savedUrl, { headers: { cookie: ownerSessionCookie(secrets) } })
    )
    const restored = await decodeSavedWeek(await restoredResponse.json())
    expect(restored.plan).toEqual(refreshed)
    expect(restored.plan?.rows.find((entry) => entry.ticketKey === "PROJ-5662")?.proposal).toBeUndefined()
    expect(fake.world.jiraWorklogs).toHaveLength(0)
    expect(JSON.stringify(refreshed)).not.toContain("Implement PROJ-5662")
    const missing = await web.handler(
      new Request("http://127.0.0.1:4179/api/week/recorded?planId=missing", {
        headers: { cookie: ownerSessionCookie(secrets) }
      })
    )
    await expect(readWeekStream(missing, () => {})).rejects.toThrow("Use Rescan sessions")
    expect(fake.world.transcriptReads).toHaveLength(1)
    await readWeekStream(
      await web.handler(new Request(url, { headers: { cookie: ownerSessionCookie(secrets) } })),
      () => {}
    )
    expect(fake.world.attributorBatches).toHaveLength(2)
    expect(fake.world.transcriptReads).toHaveLength(2)
  } finally {
    await web.dispose()
  }
})
