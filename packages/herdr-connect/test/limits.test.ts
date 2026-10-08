import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { fetchPeerLimits, fleetLimits, hubLimits } from "../src/limits-directory.js"
import type { HostLimits } from "../src/limits.js"

const hostLimits = (host: string): HostLimits => ({
  host,
  readAt: 1_000,
  reading: { _tag: "Read", limits: { machine: host, observedAt: 1_000, latest: [] } }
})

const answering = (body: HostLimits) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
      )
    )
  )

const peer = { host: "PI", online: true, limitsUrl: "http://100.64.0.2/v1/connect/limits/local" }

describe("fleet limits", () => {
  it.effect("puts this host first and adds each peer's own read", () =>
    Effect.gen(function*() {
      const fleet = yield* fleetLimits(Effect.succeed(hostLimits("SER8")), [peer]).pipe(
        Effect.provideService(HttpClient.HttpClient, answering(hostLimits("PI")))
      )
      expect(fleet).toEqual({ hosts: [hostLimits("SER8"), hostLimits("PI")], failures: [], peersListed: true })
    }))

  it.effect("lists a peer it could not ask instead of dropping it", () =>
    Effect.gen(function*() {
      const fleet = yield* fleetLimits(Effect.succeed(hostLimits("SER8")), [
        { ...peer, online: false },
        { ...peer, host: "MBP", limitsUrl: null }
      ]).pipe(Effect.provideService(HttpClient.HttpClient, answering(hostLimits("PI"))))
      expect(fleet.hosts).toEqual([hostLimits("SER8")])
      expect(fleet.failures).toEqual([{ host: "PI", reason: "offline" }, { host: "MBP", reason: "unavailable" }])
    }))

  it.effect("rejects a peer answering for another host", () =>
    Effect.gen(function*() {
      const error = yield* fetchPeerLimits(peer).pipe(
        Effect.provideService(HttpClient.HttpClient, answering(hostLimits("SER8"))),
        Effect.flip
      )
      expect(error.reason).toBe("invalid_response")
    }))

  it.effect("answers with its own read when it cannot list the fleet", () =>
    Effect.gen(function*() {
      const fleet = yield* hubLimits(Effect.succeed(hostLimits("SER8")), Effect.fail("tailscale status failed")).pipe(
        Effect.provideService(HttpClient.HttpClient, answering(hostLimits("PI")))
      )
      expect(fleet).toEqual({ hosts: [hostLimits("SER8")], failures: [], peersListed: false })
    }))
})
