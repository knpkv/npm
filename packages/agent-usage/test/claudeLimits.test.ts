import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, PlatformError } from "effect"
import { TestClock } from "effect/testing"
import {
  type ClaudeUsageDeps,
  CredentialsMissing,
  CredentialsUnreadable,
  KeychainDenied,
  KeychainFailed,
  pollClaudeLimits,
  TokenExpired,
  tokenFromCredentials,
  UsageFetchFailed
} from "../src/core/ClaudeLimits.js"
import {
  credentialsFileFailure,
  KEYCHAIN_DEADLINE,
  keychainArgs,
  keychainOutcome,
  readKeychainItem,
  withKeychainDeadline
} from "../src/core/ClaudeLimitsLive.js"

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
    return yield* pollClaudeLimits(deps, "host-a")
  })

describe("pollClaudeLimits", () => {
  it.effect("reads every metered window under its provider key, with known lengths for the published ones", () =>
    Effect.gen(function*() {
      const result = yield* poll(reply(200, body))
      expect(result.snapshots).toEqual([
        {
          agent: "claude",
          machine: "host-a",
          source: "claude-oauth-usage",
          label: "five_hour",
          windowMinutes: 300,
          observedAt: now,
          reading: { _tag: "Known", usedPercent: 12.5, resetsAt: Date.parse("2026-10-03T15:00:00Z") }
        },
        {
          agent: "claude",
          machine: "host-a",
          source: "claude-oauth-usage",
          label: "seven_day",
          windowMinutes: 10080,
          observedAt: now,
          reading: { _tag: "Known", usedPercent: 40, resetsAt: Date.parse("2026-10-07T07:00:00Z") }
        },
        {
          agent: "claude",
          machine: "host-a",
          source: "claude-oauth-usage",
          label: "iguana_necktie",
          windowMinutes: null,
          observedAt: now,
          reading: { _tag: "Known", usedPercent: 3, resetsAt: null }
        }
      ])
      expect(result.balances).toEqual([{
        kind: "claude-extra-usage",
        machine: "host-a",
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
        ["five_hour", { _tag: "Unknown", reason: "Parse", detail: "five_hour: utilization is not a number" }],
        ["seven_day", { _tag: "Unknown", reason: "Parse", detail: "seven_day: resets_at is not a time" }]
      ])
    }))

  it.effect("records an expired token as AuthExpired for limits and balance alike", () =>
    Effect.gen(function*() {
      const result = yield* poll(reply(401, "{}"))
      const expired = { _tag: "Unknown", reason: "AuthExpired", detail: "HTTP 401" }
      expect(result.snapshots.map((snapshot) => [snapshot.label, snapshot.reading])).toEqual([["*", expired]])
      expect(result.balances[0]?.value).toEqual(expired)
    }))

  it.effect("keeps each failure's typed reason and what exactly went wrong", () =>
    Effect.gen(function*() {
      const readingOf = (deps: ClaudeUsageDeps) => poll(deps).pipe(Effect.map((result) => result.snapshots[0]?.reading))
      const failing = (readToken: ClaudeUsageDeps["readToken"]): ClaudeUsageDeps => ({ ...reply(200, body), readToken })
      expect(yield* readingOf(reply(503, ""))).toEqual({ _tag: "Unknown", reason: "Fetch", detail: "HTTP 503" })
      expect(yield* readingOf(reply(200, "not json"))).toEqual({
        _tag: "Unknown",
        reason: "Parse",
        detail: "reply was not JSON"
      })
      expect(yield* readingOf(reply(200, "[]"))).toEqual({
        _tag: "Unknown",
        reason: "Parse",
        detail: "reply was JSON but not an object"
      })
      expect(yield* readingOf(failing(Effect.fail(new CredentialsMissing({ where: "file" }))))).toEqual({
        _tag: "Unknown",
        reason: "NoAuth",
        detail: "no credentials file"
      })
      expect(
        yield* readingOf(
          failing(Effect.fail(new CredentialsMissing({ where: "keychain:Claude Code-credentials-1a2b3c4d" })))
        )
      ).toEqual({ _tag: "Unknown", reason: "NoAuth", detail: "no Keychain item Claude Code-credentials-1a2b3c4d" })
      expect(yield* readingOf(failing(Effect.fail(new KeychainDenied({ exitCode: 36 }))))).toEqual({
        _tag: "Unknown",
        reason: "KeychainDenied",
        detail: "the Keychain refused access (security exited 36)"
      })
      expect(yield* readingOf(failing(Effect.fail(new KeychainDenied({ exitCode: null }))))).toEqual({
        _tag: "Unknown",
        reason: "KeychainDenied",
        detail: "the Keychain did not answer in time (locked, or waiting on a password prompt)"
      })
      expect(yield* readingOf(failing(Effect.fail(new CredentialsUnreadable({ reason: "PermissionDenied" }))))).toEqual(
        {
          _tag: "Unknown",
          reason: "NoAuth",
          detail: "the credentials file could not be read (PermissionDenied)"
        }
      )
      expect(yield* readingOf(failing(Effect.fail(new KeychainFailed({ stage: "output" }))))).toEqual({
        _tag: "Unknown",
        reason: "KeychainDenied",
        detail: "the Keychain lookup broke off while its answer was being read"
      })
      expect(yield* readingOf(failing(Effect.fail(new TokenExpired())))).toEqual({
        _tag: "Unknown",
        reason: "AuthExpired",
        detail: "the stored token expired; Claude Code renews it on its next use"
      })
      expect(
        yield* readingOf({
          ...reply(200, body),
          get: () => Effect.fail(new UsageFetchFailed({ cause: "TimeoutError" }))
        })
      ).toEqual({ _tag: "Unknown", reason: "Fetch", detail: "request failed: TimeoutError" })
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
      expect(yield* Effect.flip(tokenFromCredentials("{}"))).toEqual(new CredentialsMissing({ where: "credentials" }))
    }))
})

describe("keychain lookup", () => {
  it("asks for Claude Code's own item under the user's account", () => {
    expect(keychainArgs({ keychainService: "Claude Code-credentials-1a2b3c4d", keychainAccount: "a" })).toEqual([
      "find-generic-password",
      "-a",
      "a",
      "-w",
      "-s",
      "Claude Code-credentials-1a2b3c4d"
    ])
  })

  it.effect("tells a missing item from a refused one by the exit code", () =>
    Effect.gen(function*() {
      const service = "Claude Code-credentials"
      expect(yield* keychainOutcome(0, "{\"claudeAiOauth\":{}}\n", service)).toBe("{\"claudeAiOauth\":{}}\n")
      expect(yield* Effect.flip(keychainOutcome(44, "", service))).toEqual(
        new CredentialsMissing({ where: "keychain:Claude Code-credentials" })
      )
      expect(yield* Effect.flip(keychainOutcome(36, "", service))).toEqual(new KeychainDenied({ exitCode: 36 }))
    }))
})

describe("extra usage that cannot be read", () => {
  it.effect("says the balance part of the reply was not understood", () =>
    Effect.gen(function*() {
      const result = yield* poll(reply(200, JSON.stringify({ five_hour: { utilization: 1 }, extra_usage: 7 })))
      expect(result.balances[0]?.value).toEqual({
        _tag: "Unknown",
        reason: "Parse",
        detail: "extra_usage not understood"
      })
    }))
})

describe("credential lookups that go wrong", () => {
  it("tells a missing credentials file from one that cannot be read", () => {
    expect(credentialsFileFailure("NotFound")).toEqual(new CredentialsMissing({ where: "file" }))
    expect(credentialsFileFailure("PermissionDenied")).toEqual(
      new CredentialsUnreadable({ reason: "PermissionDenied" })
    )
  })

  it.effect("gives up on a Keychain that never answers, so the next poll still runs", () =>
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(Effect.flip(withKeychainDeadline(Effect.never)))
      yield* TestClock.adjust(KEYCHAIN_DEADLINE)
      expect(yield* Fiber.join(fiber)).toEqual(new KeychainDenied({ exitCode: null }))
    }))
})

describe("a Keychain lookup that started but broke off", () => {
  const broken = PlatformError.systemError({ _tag: "Unknown", module: "ChildProcess", method: "exitCode" })

  it.effect("is not reported as a missing credentials file", () =>
    Effect.gen(function*() {
      const service = "Claude Code-credentials"
      expect(yield* Effect.flip(readKeychainItem(Effect.fail(broken), Effect.succeed(0), service))).toEqual(
        new KeychainFailed({ stage: "output" })
      )
      expect(yield* Effect.flip(readKeychainItem(Effect.succeed("{}"), Effect.fail(broken), service))).toEqual(
        new KeychainFailed({ stage: "exit" })
      )
      expect(yield* readKeychainItem(Effect.succeed("{}"), Effect.succeed(0), service)).toBe("{}")
    }))
})
