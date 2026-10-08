import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { fetchPeerLimits, fleetLimits, type HostLimits, readAgentLimits } from "../src/agent-limits.js"

// Each test effect is an application boundary; @effect/vitest scopes its Node services.
// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

/** `agent-limits --json` as it printed on a host: Claude read, Codex stale. */
const report = {
  v: 1,
  now: 1_791_481_802_332,
  providers: {
    claude: {
      reservePp: 15,
      windows: [
        {
          window: "five_hour",
          state: {
            _tag: "Known",
            usedPercent: 19,
            resetsAt: 1_791_485_400_000,
            observedAt: 1_791_481_764_274,
            ageMs: 38_058,
            burnPerHour: { _tag: "Known", value: 5.05 },
            exhaustsAt: { _tag: "Known", value: "NotBeforeReset" },
            source: "statusline"
          }
        },
        { window: "weekly", state: { _tag: "NotReported" } }
      ]
    },
    codex: {
      reservePp: 5,
      windows: [
        {
          window: "weekly",
          state: { _tag: "Unknown", reason: "Stale", observedAt: 1_791_460_492_741, ageMs: 21_309_591 }
        },
        { window: "five_hour", state: { _tag: "Unknown", reason: "Stale" } }
      ]
    }
  }
}

/** A command that prints its one argument, standing in for the CLI. */
const printing = (output: string) => ["sh", "-c", "printf '%s' \"$1\"", "agent-limits", output]

const read = (command: ReadonlyArray<string> | undefined) => readAgentLimits("SER8", command).pipe(provideNodeServices)

describe("readAgentLimits", () => {
  it.effect("keeps every window's state, unknown ones without a number", () =>
    Effect.gen(function*() {
      const limits = yield* read(printing(JSON.stringify(report)))
      expect(limits.host).toBe("SER8")
      expect(limits.reading._tag).toBe("Read")
      if (limits.reading._tag !== "Read") return
      expect(limits.reading.limits.providers.claude.windows.map(({ state }) => state._tag)).toEqual([
        "Known",
        "NotReported"
      ])
      expect(limits.reading.limits.providers.codex.windows[0]?.state).toEqual({
        _tag: "Unknown",
        reason: "Stale",
        observedAt: 1_791_460_492_741,
        ageMs: 21_309_591
      })
    }))

  it.effect("reads the account a newer CLI reports", () =>
    Effect.gen(function*() {
      const withAccount = {
        ...report,
        providers: {
          ...report.providers,
          claude: { ...report.providers.claude, account: { _tag: "Known", id: "acct-1", label: "a@example.com" } }
        }
      }
      const limits = yield* read(printing(JSON.stringify(withAccount)))
      expect(limits.reading._tag === "Read" && limits.reading.limits.providers.claude.account).toEqual({
        _tag: "Known",
        id: "acct-1",
        label: "a@example.com"
      })
    }))

  const unavailable = (limits: HostLimits) => limits.reading._tag === "Unavailable" ? limits.reading : null

  it.effect("says the host has no command rather than showing empty limits", () =>
    Effect.gen(function*() {
      expect(unavailable(yield* read(undefined))?.reason).toBe("not_configured")
    }))

  it.effect("names a crash with the CLI's own stderr", () =>
    Effect.gen(function*() {
      const limits = yield* read(["sh", "-c", "echo 'no state dir' >&2; exit 3"])
      expect(unavailable(limits)).toEqual({ _tag: "Unavailable", reason: "failed", detail: "no state dir" })
    }))

  it.effect("refuses a newer contract instead of guessing at it", () =>
    Effect.gen(function*() {
      const limits = yield* read(printing(JSON.stringify({ ...report, v: 2 })))
      expect(unavailable(limits)?.reason).toBe("unsupported_version")
    }))

  it.effect("rejects output that is not the contract", () =>
    Effect.gen(function*() {
      expect(unavailable(yield* read(printing("not json")))?.reason).toBe("invalid_output")
      const zeroed = { ...report, providers: { ...report.providers, codex: { reservePp: 5 } } }
      expect(unavailable(yield* read(printing(JSON.stringify(zeroed))))?.reason).toBe("invalid_output")
    }))
})

const hostLimits = (host: string): HostLimits => ({
  host,
  readAt: 1_000,
  reading: { _tag: "Unavailable", reason: "not_configured", detail: "agentLimitsCommand is not set for this host" }
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

const peer = { host: "PI", online: true, limitsUrl: "http://100.64.0.2/v1/limits/local" }

describe("fleetLimits", () => {
  it.effect("puts this host first and adds each peer's own read", () =>
    Effect.gen(function*() {
      const fleet = yield* fleetLimits(Effect.succeed(hostLimits("SER8")), [peer]).pipe(
        Effect.provideService(HttpClient.HttpClient, answering(hostLimits("PI")))
      )
      expect(fleet).toEqual({ hosts: [hostLimits("SER8"), hostLimits("PI")], failures: [] })
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
})
