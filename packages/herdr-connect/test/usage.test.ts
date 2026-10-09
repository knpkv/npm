import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { failureSentences, reasonSentences } from "../src/unavailable-detail.js"
import { fetchPeerUsage, fleetUsage, hubUsage, peerUsageUrl } from "../src/usage-directory.js"
import { decodeUsageTolerantly, type HostUsage, type LooseHostUsage, type UsageNow, UsageQuery } from "../src/usage.js"

const query: UsageQuery = { range: "7d", timeZone: "Europe/Amsterdam" }

const usageOf = (machine: string): UsageNow => ({
  v: 1,
  machine,
  observedAt: 1_000,
  range: { preset: "7d", timeZone: "Europe/Amsterdam", from: 0, to: 1_000, bucket: "day" },
  periods: [{ key: "2026-10-08", start: 0 }],
  tokens: [{ period: 0, agent: "claude", model: "claude-opus-5", tokens: 1_200 }],
  limits: []
})

const hostUsage = (host: string): HostUsage => ({
  host,
  readAt: 1_000,
  reading: { _tag: "Read", usage: usageOf(host), skipped: 0 }
})

const asked: Array<string> = []
const answering = (body: typeof LooseHostUsage.Type) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      asked.push(request.url)
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
      )
    })
  )

const peer = { host: "PI", online: true, usageUrl: "http://100.64.0.2/v1/connect/usage/local" }

describe("usage query", () => {
  it("takes a known range and an IANA-shaped zone, and nothing that could split a command line", () => {
    const decode = Schema.decodeUnknownOption(UsageQuery)
    expect(decode({ range: "30d", timeZone: "America/Argentina/Buenos_Aires" })._tag).toBe("Some")
    expect(decode({ range: "30d", timeZone: "Etc/GMT+3" })._tag).toBe("Some")
    for (const timeZone of ["UTC limits", "UTC\nmint", "--range", "", "a".repeat(65)]) {
      expect(decode({ range: "7d", timeZone })._tag, timeZone).toBe("None")
    }
    expect(decode({ range: "90d", timeZone: "UTC" })._tag).toBe("None")
  })

  it("asks a peer for the same range and zone", () => {
    expect(peerUsageUrl(peer.usageUrl, query)).toBe(
      "http://100.64.0.2/v1/connect/usage/local?range=7d&timeZone=Europe%2FAmsterdam"
    )
  })
})

describe("fleet usage", () => {
  it.effect("puts this host first and adds each peer's own read for the query", () =>
    Effect.gen(function*() {
      asked.length = 0
      const fleet = yield* fleetUsage(query, Effect.succeed(hostUsage("SER8")), [peer]).pipe(
        Effect.provideService(HttpClient.HttpClient, answering(hostUsage("PI")))
      )
      expect(fleet).toEqual({ hosts: [hostUsage("SER8"), hostUsage("PI")], failures: [], peersListed: true })
      expect(asked).toEqual([peerUsageUrl(peer.usageUrl, query)])
    }))

  it.effect("lists a peer it could not ask, and answers alone when the fleet cannot be listed", () =>
    Effect.gen(function*() {
      const fleet = yield* fleetUsage(query, Effect.succeed(hostUsage("SER8")), [
        { ...peer, online: false },
        { ...peer, host: "MBP", usageUrl: null }
      ]).pipe(Effect.provideService(HttpClient.HttpClient, answering(hostUsage("PI"))))
      expect(fleet.failures).toEqual([{ host: "PI", reason: "offline" }, { host: "MBP", reason: "unavailable" }])
      const alone = yield* hubUsage(query, Effect.succeed(hostUsage("SER8")), Effect.fail("tailscale down")).pipe(
        Effect.provideService(HttpClient.HttpClient, answering(hostUsage("PI")))
      )
      expect(alone).toEqual({ hosts: [hostUsage("SER8")], failures: [], peersListed: false })
    }))

  it.effect("rejects a peer answering for another host", () =>
    Effect.gen(function*() {
      const error = yield* fetchPeerUsage(query)(peer).pipe(
        Effect.provideService(HttpClient.HttpClient, answering(hostUsage("SER8"))),
        Effect.flip
      )
      expect(error.reason).toBe("invalid_response")
    }))
})

// An older peer's hostd sent agent-usage's stderr as is; the hub passes on only sentences it knows.
describe("a peer's unavailable detail", () => {
  it.effect("keeps a known sentence and replaces anything else with its reason's", () =>
    Effect.gen(function*() {
      const unavailableFrom = (detail: string) =>
        fetchPeerUsage(query)(peer).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            answering({ host: "PI", readAt: 0, reading: { _tag: "Unavailable", reason: "failed", detail } })
          )
        )
      const leaked = yield* unavailableFrom(
        "agent-usage: agent-usage refused its control socket at /home/alice/.local/state/agent-usage/serve.sock"
      )
      expect(leaked.reading).toEqual({ _tag: "Unavailable", reason: "failed", detail: reasonSentences.failed })
      const known = yield* unavailableFrom(failureSentences.notRunning)
      expect(known.reading).toMatchObject({ detail: failureSentences.notRunning })
    }))
})

describe("decodeUsageTolerantly", () => {
  it("keeps a newer agent-usage's readable cells and series and counts the rest", () => {
    const base = usageOf("PI")
    const series = { agent: "claude", label: "five_hour", windowMinutes: 300, points: [] }
    const read = decodeUsageTolerantly({
      ...base,
      tokens: [...base.tokens, { ...base.tokens[0], agent: "gemini" }, { ...base.tokens[0], period: 5 }],
      limits: [series, { ...series, agent: "gemini" }]
    })
    expect(read).toEqual({ _tag: "Read", usage: { ...base, limits: [series] }, skipped: 3 })
  })

  it("says a different version is unsupported, not malformed", () => {
    expect(decodeUsageTolerantly({ ...usageOf("PI"), v: 2 })).toEqual({ _tag: "UnsupportedVersion", version: "2" })
    expect(decodeUsageTolerantly({ v: 1, machine: "PI" })._tag).toBe("Invalid")
  })
})
