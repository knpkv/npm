import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import {
  type ClaudeUsageDeps,
  CredentialsMissing,
  pollClaudeLimits,
  TokenExpired,
  tokenFromCredentials,
  UsageFetchFailed
} from "../src/core/ClaudeLimits.js"

const now = Date.parse("2026-10-03T12:00:00.000Z")

const reply = (status: number, body: string): ClaudeUsageDeps => ({
  readToken: Effect.succeed("synthetic-token"),
  get: () => Effect.succeed({ status, body })
})

const body = JSON.stringify({
  five_hour: { utilization: 12.5, resets_at: "2026-10-03T15:00:00+00:00" },
  seven_day: { utilization: 40, resets_at: "2026-10-07T07:00:00+00:00" },
  seven_day_opus: null,
  iguana_necktie: { utilization: 3, resets_at: null },
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: 12, user_disabled: true },
  limits: [{ kind: "session", percent: 12 }]
})

const poll = (deps: ClaudeUsageDeps) =>
  Effect.gen(function*() {
    yield* TestClock.setTime(now)
    return yield* pollClaudeLimits(deps, "ser8")
  })

describe("pollClaudeLimits", () => {
  it.effect("reads every metered window under its provider key, with known lengths for the published ones", () =>
    Effect.gen(function*() {
      const result = yield* poll(reply(200, body))
      expect(result.snapshots).toEqual([
        {
          agent: "claude",
          machine: "ser8",
          source: "claude-oauth-usage",
          label: "five_hour",
          windowMinutes: 300,
          observedAt: now,
          reading: { _tag: "Known", usedPercent: 12.5, resetsAt: Date.parse("2026-10-03T15:00:00Z") }
        },
        {
          agent: "claude",
          machine: "ser8",
          source: "claude-oauth-usage",
          label: "seven_day",
          windowMinutes: 10080,
          observedAt: now,
          reading: { _tag: "Known", usedPercent: 40, resetsAt: Date.parse("2026-10-07T07:00:00Z") }
        },
        {
          agent: "claude",
          machine: "ser8",
          source: "claude-oauth-usage",
          label: "iguana_necktie",
          windowMinutes: null,
          observedAt: now,
          reading: { _tag: "Known", usedPercent: 3, resetsAt: null }
        }
      ])
      expect(result.balances).toEqual([{
        kind: "claude-extra-usage",
        machine: "ser8",
        observedAt: now,
        value: { _tag: "Known", balance: { _tag: "Disabled" } }
      }])
    }))

  it.effect("reads a window that is there but malformed as Unknown, so its last level does not carry on", () =>
    Effect.gen(function*() {
      const malformed = JSON.stringify({
        five_hour: { utilization: "lots", resets_at: "2026-10-03T15:00:00+00:00" },
        seven_day: { utilization: 40, resets_at: "not a time" },
        seven_day_opus: null,
        extra_usage: null
      })
      const result = yield* poll(reply(200, malformed))
      expect(result.snapshots.map((snapshot) => [snapshot.label, snapshot.reading])).toEqual([
        ["five_hour", { _tag: "Unknown", reason: "Parse" }],
        ["seven_day", { _tag: "Unknown", reason: "Parse" }]
      ])
    }))

  it.effect("records an expired token as AuthExpired for limits and balance alike", () =>
    Effect.gen(function*() {
      const result = yield* poll(reply(401, "{}"))
      expect(result.snapshots.map((snapshot) => [snapshot.label, snapshot.reading])).toEqual([
        ["*", { _tag: "Unknown", reason: "AuthExpired" }]
      ])
      expect(result.balances[0]?.value).toEqual({ _tag: "Unknown", reason: "AuthExpired" })
    }))

  it.effect("classifies each failure as its own Unknown reason", () =>
    Effect.gen(function*() {
      const reasonOf = (deps: ClaudeUsageDeps) => poll(deps).pipe(Effect.map((result) => result.snapshots[0]?.reading))
      expect(yield* reasonOf(reply(500, ""))).toEqual({ _tag: "Unknown", reason: "Fetch" })
      expect(yield* reasonOf(reply(200, "not json"))).toEqual({ _tag: "Unknown", reason: "Parse" })
      expect(yield* reasonOf({ ...reply(200, body), readToken: Effect.fail(new CredentialsMissing()) })).toEqual({
        _tag: "Unknown",
        reason: "NoAuth"
      })
      expect(yield* reasonOf({ ...reply(200, body), readToken: Effect.fail(new TokenExpired()) })).toEqual({
        _tag: "Unknown",
        reason: "AuthExpired"
      })
      expect(
        yield* reasonOf({ ...reply(200, body), get: () => Effect.fail(new UsageFetchFailed({ cause: "offline" })) })
      ).toEqual({ _tag: "Unknown", reason: "Fetch" })
    }))
})

describe("tokenFromCredentials", () => {
  it.effect("returns the access token while it is valid and never refreshes an expired one", () =>
    Effect.gen(function*() {
      const credentials = (expiresAt: number) =>
        JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-token", refreshToken: "never-used", expiresAt } })
      yield* TestClock.setTime(now)
      expect(yield* tokenFromCredentials(credentials(now + 60_000))).toBe("synthetic-token")
      expect(yield* Effect.flip(tokenFromCredentials(credentials(now - 1)))).toBeInstanceOf(TokenExpired)
      expect(yield* Effect.flip(tokenFromCredentials("{}"))).toBeInstanceOf(CredentialsMissing)
    }))
})
