import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { HostConfiguration, type HostOperations, JobStore, makeFleetService } from "@knpkv/herdr-fleet"
import type { WorkGoal, WorkSnapshots } from "@knpkv/herdr-work"
import { Effect, Redacted, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { startHttpServer, type UiAssets } from "../src/http.js"
import { LanWorkPage, LanWorkPairPage } from "../src/lan-work-view.js"
import { LanWorkConfigurationError, LanWorkPairingCode, lanWorkPairingLifetimeMs } from "../src/lan-work.js"

// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

const config = (stateDirectory: string): HostConfiguration => ({
  allowedUsers: ["andrey@example.com"],
  applyCommand: null,
  browserMcpRecoverCommand: null,
  applyMachines: ["SER8"],
  approvalHub: { host: "SER8", nodeId: "node-ser8", url: "https://ser8.example.test:4779/" },
  approvalNodes: ["node-ser8"],
  approvalPort: 4779,
  checkCommand: ["nix", "flake", "check"],
  coordinatorCommand: ["coordinator"],
  crossHost: false,
  herdrCommand: "herdr",
  host: "SER8",
  localPort: 0,
  machines: [{ host: "SER8", nodeId: "node-ser8" }],
  port: 0,
  pushAllowedOrigins: [],
  pushSubject: "mailto:andrey@example.com",
  repository: "/repo",
  approvalTls: null,
  stateDirectory,
  tailscaleCommand: "tailscale"
})

const operations: HostOperations = {
  inspect: () =>
    Effect.succeed({ applyConfigured: false, branch: "main", dirty: false, repository: "/repo", revision: "abc" }),
  listAgents: () => Effect.succeed({ agents: [], available: true, error: null }),
  run: (payload) => Effect.succeed(`${payload.kind}: ok`),
  runLocal: (payload) => Effect.succeed(`${payload.kind}: ok`),
  runCoordinatorChat: () => Effect.succeed("coordinator: ok")
}

const assets: UiAssets = {
  connectScript: "",
  fonts: new Map([["test.woff2", new Uint8Array([1])]]),
  script: "",
  stylesheet: "",
  worker: ""
}

const emptySnapshots = {
  observedAt: 0,
  now: { asOf: 0, observedAt: 0, window: "now", goals: [] },
  day: { asOf: 0, observedAt: 0, window: "day", goals: [] },
  week: { asOf: 0, observedAt: 0, window: "week", goals: [] },
  month: { asOf: 0, observedAt: 0, window: "month", goals: [] }
} satisfies WorkSnapshots

const staticGoal = {
  blocker: null,
  connectTarget: null,
  createdAt: 0,
  delivery: "local",
  detail: "Inspect the read-only LAN projection",
  id: "goal-lan",
  owner: { id: "owner-lan", name: "LAN owner" },
  repository: { branch: "main", repository: "npm" },
  spend: null,
  state: "working",
  summary: "Review LAN Work",
  title: "LAN Work",
  updatedAt: 0
} satisfies WorkGoal

const staticSnapshots = {
  observedAt: 0,
  now: { asOf: 0, observedAt: 0, window: "now", goals: [staticGoal] },
  day: { asOf: 0, observedAt: 0, window: "day", goals: [staticGoal] },
  week: { asOf: 0, observedAt: 0, window: "week", goals: [staticGoal] },
  month: { asOf: 0, observedAt: 0, window: "month", goals: [staticGoal] }
} satisfies WorkSnapshots

const responseError = async (response: Response): Promise<string> => {
  const body = await response.json()
  const decoded = Schema.decodeUnknownSync(Schema.Struct({ error: Schema.String }))(body)
  return decoded.error
}

const responseText = (response: Response): Promise<string> => response.text()

const expectLanConfigurationFailure = (
  configuration: HostConfiguration,
  lanWork: NonNullable<Parameters<typeof startHttpServer>[3]>["lanWork"]
) => {
  if (lanWork === undefined) throw new Error("LAN configuration fixture is required")
  const root = configuration.stateDirectory
  return Effect.gen(function*() {
    yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
    const jobStore = yield* JobStore.open(join(root, "jobs.sqlite"))
    yield* Effect.addFinalizer(() => Effect.sync(() => jobStore.close()))
    const fleet = yield* makeFleetService({
      approvalEnabled: false,
      host: configuration.host,
      operations,
      store: jobStore
    })
    const outcome = yield* Effect.promise(() =>
      startHttpServer(configuration, fleet, assets, { lanWork }).then(
        async (running) => {
          await running.close()
          return "resolved"
        },
        (error) => Schema.is(LanWorkConfigurationError)(error) ? "LanWorkConfigurationError" : "unexpected"
      )
    )
    expect(outcome).toBe("LanWorkConfigurationError")
  }).pipe(Effect.scoped, provideNodeServices)
}

describe("LAN Work pairing boundary", () => {
  it.effect("rejects unpaired and cross-origin access, then permits paired Work reads only", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-lan-work-"))
    return Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const jobStore = yield* JobStore.open(join(root, "jobs.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => jobStore.close()))
      const fleet = yield* makeFleetService({ approvalEnabled: false, host: "SER8", operations, store: jobStore })
      const server = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startHttpServer(config(root), fleet, assets, {
            lanWork: { address: "127.0.0.1", port: 0 },
            terminalConnector: { open: () => Effect.die("LAN test must not open a terminal") }
          })
        ),
        (running) => Effect.promise(running.close)
      )
      const lanUrl = server.lanWorkUrl
      const pairingCode = server.lanWorkPairingCode
      expect(lanUrl).not.toBeNull()
      expect(pairingCode).not.toBeNull()
      if (lanUrl === null || pairingCode === null) return
      const origin = lanUrl

      const unpaired = yield* Effect.promise(() => fetch(`${lanUrl}/v1/work`, { headers: { origin } }))
      expect(unpaired.status).toBe(401)
      expect(yield* Effect.promise(() => responseError(unpaired))).toBe("LanWorkSessionRequiredError")
      const unpairedPage = yield* Effect.promise(() => fetch(`${lanUrl}/`, { redirect: "manual" }))
      expect(unpairedPage.status).toBe(303)
      expect(unpairedPage.headers.get("location")).toBe("/pair")
      const pairPage = yield* Effect.promise(() => fetch(`${lanUrl}/pair`, { headers: { accept: "text/html" } }))
      expect(pairPage.status).toBe(200)
      expect(pairPage.headers.get("content-security-policy")).toBe("frame-ancestors 'none'")
      expect(pairPage.headers.get("x-frame-options")).toBe("DENY")

      const boundary = yield* Effect.promise(() => fetch(`${lanUrl}/v1/dashboard`))
      expect(boundary.status).toBe(404)
      const stylesheet = yield* Effect.promise(() => fetch(`${lanUrl}/assets/index.css`))
      expect(stylesheet.status).toBe(200)
      const font = yield* Effect.promise(() => fetch(`${lanUrl}/assets/test.woff2`))
      expect(font.status).toBe(200)
      const approvalAsset = yield* Effect.promise(() => fetch(`${lanUrl}/assets/approval.js`))
      expect(approvalAsset.status).toBe(404)
      for (
        const forbiddenPath of [
          "/v1/chat",
          "/v1/connect/agents",
          "/v1/pending-approval",
          "/v1/secrets"
        ]
      ) {
        const forbidden = yield* Effect.promise(() => fetch(`${lanUrl}${forbiddenPath}`))
        expect(forbidden.status).toBe(404)
      }
      const crossOrigin = yield* Effect.promise(() =>
        fetch(`${lanUrl}/v1/work`, { headers: { origin: "http://evil.example.test" } })
      )
      expect(crossOrigin.status).toBe(403)
      expect(yield* Effect.promise(() => responseError(crossOrigin))).toBe("LanWorkOriginRejectedError")

      const crossOriginPair = yield* Effect.promise(() =>
        fetch(`${lanUrl}/pair`, {
          body: JSON.stringify({ pairingCode: Redacted.value(pairingCode) }),
          headers: { "content-type": "application/json", origin: "http://evil.example.test" },
          method: "POST"
        })
      )
      expect(crossOriginPair.status).toBe(403)
      expect(yield* Effect.promise(() => responseError(crossOriginPair))).toBe("LanWorkOriginRejectedError")

      const missingOriginPair = yield* Effect.promise(() =>
        fetch(`${lanUrl}/pair`, {
          body: JSON.stringify({ pairingCode: Redacted.value(pairingCode) }),
          headers: { "content-type": "application/json" },
          method: "POST"
        })
      )
      expect(missingOriginPair.status).toBe(403)
      expect(yield* Effect.promise(() => responseError(missingOriginPair))).toBe("LanWorkOriginRejectedError")

      const malformed = yield* Effect.promise(() =>
        fetch(`${lanUrl}/pair`, {
          body: JSON.stringify({ pairingCode: "too-short" }),
          headers: { "content-type": "application/json", origin },
          method: "POST"
        })
      )
      expect(malformed.status).toBe(400)
      expect(malformed.headers.get("content-security-policy")).toBeNull()
      expect(malformed.headers.get("x-frame-options")).toBeNull()
      expect(yield* Effect.promise(() => responseError(malformed))).toBe("LanWorkPairingMalformedError")

      const malformedPage = yield* Effect.promise(() =>
        fetch(`${lanUrl}/pair`, {
          body: JSON.stringify({ pairingCode: "too-short" }),
          headers: { accept: "text/html", "content-type": "application/json", origin },
          method: "POST"
        })
      )
      const malformedPageBody = yield* Effect.promise(() => responseText(malformedPage))
      expect(malformedPage.status).toBe(400)
      expect(malformedPage.headers.get("content-security-policy")).toBe("frame-ancestors 'none'")
      expect(malformedPage.headers.get("x-frame-options")).toBe("DENY")
      expect(malformedPageBody).toContain("Enter the 64-character pairing code")
      expect(malformedPageBody).not.toContain("LanWorkPairingMalformedError")

      const rejected = yield* Effect.promise(() =>
        fetch(`${lanUrl}/pair`, {
          body: JSON.stringify({ pairingCode: "0".repeat(64) }),
          headers: { "content-type": "application/json", origin },
          method: "POST"
        })
      )
      expect(rejected.status).toBe(401)
      expect(yield* Effect.promise(() => responseError(rejected))).toBe("LanWorkPairingRejectedError")

      const paired = yield* Effect.promise(() =>
        fetch(`${lanUrl}/pair`, {
          body: JSON.stringify({ pairingCode: Redacted.value(pairingCode) }),
          headers: { "content-type": "application/json", origin },
          method: "POST",
          redirect: "manual"
        })
      )
      expect(paired.status).toBe(303)
      const setCookie = paired.headers.get("set-cookie")
      expect(setCookie).toContain("herdr_lan_work=")
      if (setCookie === null) return
      const cookie = setCookie.split(";", 1)[0]

      const work = yield* Effect.promise(() => fetch(`${lanUrl}/v1/work`, { headers: { cookie, origin } }))
      expect(work.status).toBe(200)
      expect(work.headers.get("cache-control")).toBe("no-store")
      const workBody = yield* Effect.promise(() => work.json())
      expect(
        Schema.decodeUnknownSync(Schema.Struct({ now: Schema.Struct({ goals: Schema.Array(Schema.Unknown) }) }))(
          workBody
        ).now.goals
      ).toEqual([])
      const pairedPage = yield* Effect.promise(() => fetch(`${lanUrl}/`, { headers: { cookie, origin } }))
      expect(pairedPage.status).toBe(200)
      expect(pairedPage.headers.get("content-security-policy")).toBe("frame-ancestors 'none'")
      expect(pairedPage.headers.get("x-frame-options")).toBe("DENY")
      const historicalPage = yield* Effect.promise(() =>
        fetch(`${lanUrl}/?window=week`, { headers: { cookie, origin } })
      )
      expect(historicalPage.status).toBe(200)
      expect(yield* Effect.promise(() => historicalPage.text())).toContain("aria-current=\"page\"")
      const malformedSelection = yield* Effect.promise(() =>
        fetch(`${lanUrl}/?window=invalid`, { headers: { cookie, origin } })
      )
      expect(malformedSelection.status).toBe(400)
      expect(yield* Effect.promise(() => responseError(malformedSelection))).toBe("LanWorkSelectionMalformedError")
      const missingOriginWork = yield* Effect.promise(() => fetch(`${lanUrl}/v1/work`, { headers: { cookie } }))
      expect(missingOriginWork.status).toBe(403)
      expect(yield* Effect.promise(() => responseError(missingOriginWork))).toBe("LanWorkOriginRejectedError")
      const pairedCrossOrigin = yield* Effect.promise(() =>
        fetch(`${lanUrl}/v1/work`, { headers: { cookie, origin: "http://evil.example.test" } })
      )
      expect(pairedCrossOrigin.status).toBe(403)
      expect(yield* Effect.promise(() => responseError(pairedCrossOrigin))).toBe("LanWorkOriginRejectedError")
      const rejectedCookie = yield* Effect.promise(() =>
        fetch(`${lanUrl}/v1/work`, { headers: { cookie: "herdr_lan_work=not-a-session", origin } })
      )
      expect(rejectedCookie.status).toBe(401)
      expect(yield* Effect.promise(() => responseError(rejectedCookie))).toBe("LanWorkSessionRejectedError")

      const replay = yield* Effect.promise(() =>
        fetch(`${lanUrl}/pair`, {
          body: JSON.stringify({ pairingCode: Redacted.value(pairingCode) }),
          headers: { "content-type": "application/json", origin },
          method: "POST"
        })
      )
      expect(replay.status).toBe(401)
      expect(yield* Effect.promise(() => responseError(replay))).toBe("LanWorkPairingReplayedError")

      const replayPage = yield* Effect.promise(() =>
        fetch(`${lanUrl}/pair`, {
          body: JSON.stringify({ pairingCode: Redacted.value(pairingCode) }),
          headers: { accept: "text/html", "content-type": "application/json", origin },
          method: "POST"
        })
      )
      const replayPageBody = yield* Effect.promise(() => responseText(replayPage))
      expect(replayPage.status).toBe(401)
      expect(replayPageBody).toContain("already used")
      expect(replayPageBody).not.toContain("LanWorkPairingReplayedError")

      const forbiddenMutation = yield* Effect.promise(() =>
        fetch(`${lanUrl}/v1/jobs`, { headers: { cookie, origin }, method: "POST" })
      )
      expect(forbiddenMutation.status).toBe(404)
      const forbiddenConnect = yield* Effect.promise(() => fetch(`${lanUrl}/connect/`, { headers: { cookie } }))
      expect(forbiddenConnect.status).toBe(404)
    }).pipe(Effect.scoped, provideNodeServices)
  })

  it.effect("rejects a pairing code at five-minute expiry", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-lan-work-expiry-"))
    let currentNow = 10_000
    return Effect.gen(function*() {
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { force: true, recursive: true })))
      const jobStore = yield* JobStore.open(join(root, "jobs.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => jobStore.close()))
      const fleet = yield* makeFleetService({ approvalEnabled: false, host: "SER8", operations, store: jobStore })
      const server = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startHttpServer(config(root), fleet, assets, {
            lanWork: { address: "127.0.0.1", port: 0 },
            now: () => currentNow,
            terminalConnector: { open: () => Effect.die("LAN test must not open a terminal") }
          })
        ),
        (running) => Effect.promise(running.close)
      )
      const lanUrl = server.lanWorkUrl
      const pairingCode = server.lanWorkPairingCode
      expect(lanUrl).not.toBeNull()
      expect(pairingCode).not.toBeNull()
      if (lanUrl === null || pairingCode === null) return
      currentNow += lanWorkPairingLifetimeMs
      const expired = yield* Effect.promise(() =>
        fetch(`${lanUrl}/pair`, {
          body: new URLSearchParams({ pairingCode: Redacted.value(pairingCode) }),
          headers: { "content-type": "application/x-www-form-urlencoded", origin: lanUrl },
          method: "POST"
        })
      )
      expect(expired.status).toBe(401)
      expect(yield* Effect.promise(() => responseError(expired))).toBe("LanWorkPairingExpiredError")

      const expiredPage = yield* Effect.promise(() =>
        fetch(`${lanUrl}/pair`, {
          body: new URLSearchParams({ pairingCode: Redacted.value(pairingCode) }),
          headers: { accept: "text/html", "content-type": "application/x-www-form-urlencoded", origin: lanUrl },
          method: "POST"
        })
      )
      const expiredPageBody = yield* Effect.promise(() => responseText(expiredPage))
      expect(expiredPage.status).toBe(401)
      expect(expiredPageBody).toContain("expired")
      expect(expiredPageBody).not.toContain("LanWorkPairingExpiredError")
    }).pipe(Effect.scoped, provideNodeServices)
  })

  it("keeps the pairing form secret-free and the Work view read-only", () => {
    const pairMarkup = renderToStaticMarkup(LanWorkPairPage({}))
    expect(pairMarkup).toContain("action=\"/pair\"")
    expect(pairMarkup).toContain("name=\"pairingCode\"")
    expect(pairMarkup).toContain("never placed in a URL")
    expect(pairMarkup).not.toContain("?pairingCode=")
    const workMarkup = renderToStaticMarkup(LanWorkPage({ snapshots: emptySnapshots }))
    expect(workMarkup).toContain("Daily fleet Work")
    expect(workMarkup).toContain("href=\"/?window=week\"")
    expect(workMarkup).not.toContain("href=\"https://")
    expect(workMarkup).not.toContain("approve")
    expect(workMarkup).not.toContain("connect")
    const goalMarkup = renderToStaticMarkup(
      LanWorkPage({ goalId: "goal-lan", snapshots: staticSnapshots, window: "week" })
    )
    expect(goalMarkup).toContain("href=\"/?window=week&amp;goal=goal-lan\"")
    expect(goalMarkup).toContain("Inspect the read-only LAN projection")
  })

  it("validates the generated pairing code shape", () => {
    expect(Schema.is(LanWorkPairingCode)("a".repeat(64))).toBe(true)
    expect(Schema.is(LanWorkPairingCode)("A".repeat(64))).toBe(false)
    expect(Schema.is(LanWorkPairingCode)("a".repeat(63))).toBe(false)
  })

  it("requires an explicit, non-colliding LAN listener in fleet configuration", () => {
    const configured = {
      ...config("/state"),
      lanWork: { address: "0.0.0.0", host: "ser8.lan", port: 3_004 },
      localPort: 3_001,
      port: 3_002
    }
    expect(Schema.is(HostConfiguration)(configured)).toBe(true)
    expect(
      Schema.is(HostConfiguration)({
        ...configured,
        lanWork: { ...configured.lanWork, port: configured.localPort }
      })
    ).toBe(false)
  })

  it.effect("rejects LAN Work without an allowed user", () =>
    expectLanConfigurationFailure(
      { ...config(mkdtempSync(join(tmpdir(), "herdr-lan-work-no-user-"))), allowedUsers: [] },
      { address: "127.0.0.1", port: 0 }
    ))

  it.effect("rejects wildcard LAN Work without an explicit host", () =>
    expectLanConfigurationFailure(
      config(mkdtempSync(join(tmpdir(), "herdr-lan-work-wildcard-"))),
      { address: "0.0.0.0", port: 0 }
    ))
})
