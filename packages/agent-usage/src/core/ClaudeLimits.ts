/**
 * Claude's subscription limits and extra-usage balance, polled from `GET /api/oauth/usage`: the
 * endpoint Claude Code's `/usage` dialog reads. Claude limits appear in no transcript, so a poll is
 * the only way to see them, and a Limit Snapshot not taken is gone.
 *
 * **Mental model** (the rules claude-statusline already follows)
 *
 * - **The token goes to Anthropic and nowhere else.** It is read per poll, put in the request
 *   header, and never cached, logged or carried in an error.
 * - **Never refresh.** Rotating the refresh token would race Claude Code's own refresh; an expired
 *   token waits for Claude Code to renew it.
 * - **Every failure is a reading.** No credentials, an expired token, a failed request and an
 *   unparseable reply each become an Unknown Limit Snapshot (label `*`) and an Unknown balance, so
 *   the gap shows on the graph instead of the last value lingering.
 * - **Provider keys are labels.** Any top-level window with a numeric `utilization` is recorded under
 *   its key; `five_hour` and the `seven_day*` keys have known lengths, the rest are listed with an
 *   unknown length rather than dropped.
 *
 * @module
 */
import { Clock, Data, Effect, Option, Predicate, Schema } from "effect"
import { classifyExtraUsage, ExtraUsage } from "./Balances.js"
import type { BalanceReading, LimitSnapshot, UnknownReason, WindowMinutes } from "./Model.js"

/**
 * No usable credentials. `where` names the last place looked: `file`, `keychain:<service>` (the item
 * is absent), or `credentials` (found, but not Claude Code's OAuth credentials).
 */
export class CredentialsMissing extends Data.TaggedError("CredentialsMissing")<{ readonly where: string }> {}
/** The credentials file exists but could not be read; `reason` is the platform's failure kind. */
export class CredentialsUnreadable extends Data.TaggedError("CredentialsUnreadable")<{ readonly reason: string }> {}
/**
 * The Keychain would not hand over the item: `security` exited with `exitCode` (locked Keychain, no
 * GUI session, access denied), or, when `exitCode` is null, did not answer before the deadline.
 */
export class KeychainDenied extends Data.TaggedError("KeychainDenied")<{ readonly exitCode: number | null }> {}
export class TokenExpired extends Data.TaggedError("TokenExpired")<{}> {}
/** The request itself failed; `cause` is the failure's kind only, never the request carrying the token. */
export class UsageFetchFailed extends Data.TaggedError("UsageFetchFailed")<{ readonly cause: string }> {}

export interface UsageReply {
  readonly status: number
  readonly body: string
}

/** How a poll reaches the token and the endpoint; the live pair lives at the executable boundary. */
export interface ClaudeUsageDeps {
  readonly readToken: Effect.Effect<string, CredentialsMissing | CredentialsUnreadable | KeychainDenied | TokenExpired>
  readonly get: (token: string) => Effect.Effect<UsageReply, UsageFetchFailed>
}

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"

const Credentials = Schema.fromJsonString(Schema.Struct({
  claudeAiOauth: Schema.Struct({
    accessToken: Schema.NonEmptyString,
    expiresAt: Schema.optionalKey(Schema.Finite)
  })
}))
const decodeCredentials = Schema.decodeUnknownOption(Credentials)

/** The access token in Claude Code's credentials JSON, refusing one that has already expired. */
export const tokenFromCredentials = (raw: string): Effect.Effect<string, CredentialsMissing | TokenExpired> =>
  Effect.gen(function*() {
    const credentials = decodeCredentials(raw)
    if (Option.isNone(credentials)) return yield* new CredentialsMissing({ where: "credentials" })
    const { accessToken, expiresAt } = credentials.value.claudeAiOauth
    const now = yield* Clock.currentTimeMillis
    if (expiresAt !== undefined && expiresAt <= now) return yield* new TokenExpired()
    return accessToken
  })

const Window = Schema.Struct({
  utilization: Schema.Finite,
  resets_at: Schema.optionalKey(Schema.NullOr(Schema.String))
})
const decodeWindow = Schema.decodeUnknownOption(Window)
const decodeReply = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
)
const decodeExtraUsage = Schema.decodeUnknownOption(Schema.NullOr(ExtraUsage))

const windowMinutes = (label: string): WindowMinutes =>
  label === "five_hour" ? 300 : label.startsWith("seven_day") ? 10_080 : null

interface Observations {
  readonly snapshots: ReadonlyArray<LimitSnapshot>
  readonly balances: ReadonlyArray<BalanceReading>
}

const unknownObservations = (
  machine: string,
  observedAt: number,
  reason: UnknownReason,
  detail: string
): Observations => ({
  snapshots: [{
    agent: "claude",
    machine,
    source: "claude-oauth-usage",
    label: "*",
    windowMinutes: null,
    observedAt,
    reading: { _tag: "Unknown", reason, detail }
  }],
  balances: [{ kind: "claude-extra-usage", machine, observedAt, value: { _tag: "Unknown", reason, detail } }]
})

const classify = (machine: string, observedAt: number, reply: UsageReply): Observations => {
  if (reply.status === 401 || reply.status === 403) {
    return unknownObservations(machine, observedAt, "AuthExpired", `HTTP ${reply.status}`)
  }
  if (reply.status !== 200) return unknownObservations(machine, observedAt, "Fetch", `HTTP ${reply.status}`)
  const decoded = decodeReply(reply.body)
  if (Option.isNone(decoded)) return unknownObservations(machine, observedAt, "Parse", "reply was not JSON")
  // Extra usage is a balance, not a percentage window, even when it reports a utilization.
  const windows = Object.entries(decoded.value).filter(([label]) => label !== "extra_usage")
  const snapshots = windows.flatMap(([label, value]): ReadonlyArray<LimitSnapshot> => {
    const window = decodeWindow(value)
    const snapshot = (reading: LimitSnapshot["reading"]): ReadonlyArray<LimitSnapshot> => [{
      agent: "claude",
      machine,
      source: "claude-oauth-usage",
      label,
      windowMinutes: windowMinutes(label),
      observedAt,
      reading
    }]
    if (Option.isNone(window)) {
      // A window that is there but does not read is a failed reading of it, not silence: its last
      // level must not carry on.
      const claimsWindow = Predicate.hasProperty(value, "utilization") && value.utilization !== null
      return claimsWindow ? snapshot({ _tag: "Unknown", reason: "Parse" }) : []
    }
    const resets = window.value.resets_at
    if (resets === undefined || resets === null) {
      return snapshot({ _tag: "Known", usedPercent: window.value.utilization, resetsAt: null })
    }
    const resetsAt = Date.parse(resets)
    return Number.isFinite(resetsAt)
      ? snapshot({ _tag: "Known", usedPercent: window.value.utilization, resetsAt })
      : snapshot({ _tag: "Unknown", reason: "Parse" })
  })
  const extra = decodeExtraUsage(decoded.value["extra_usage"] ?? null)
  const balance: BalanceReading = {
    kind: "claude-extra-usage",
    machine,
    observedAt,
    value: Option.isNone(extra) ? { _tag: "Unknown", reason: "Parse" } : classifyExtraUsage(extra.value)
  }
  return {
    snapshots: snapshots.length === 0
      ? unknownObservations(machine, observedAt, "NoData", "the reply named no limit window").snapshots
      : snapshots,
    balances: [balance]
  }
}

const describeMissing = (where: string): string =>
  where === "file"
    ? "no credentials file"
    : where === "credentials"
    ? "the stored credentials are not Claude Code's OAuth credentials"
    : `no Keychain item ${where.replace(/^keychain:/u, "")}`

/** One poll's observations. Never fails: every failure is an Unknown reading, with its detail. */
export const pollClaudeLimits = (deps: ClaudeUsageDeps, machine: string): Effect.Effect<Observations> =>
  Effect.gen(function*() {
    const observedAt = yield* Clock.currentTimeMillis
    return yield* deps.readToken.pipe(
      Effect.flatMap(deps.get),
      Effect.map((reply) => classify(machine, observedAt, reply)),
      Effect.catchTags({
        CredentialsMissing: (error) =>
          Effect.succeed(unknownObservations(machine, observedAt, "NoAuth", describeMissing(error.where))),
        CredentialsUnreadable: (error) =>
          Effect.succeed(
            unknownObservations(
              machine,
              observedAt,
              "NoAuth",
              `the credentials file could not be read (${error.reason})`
            )
          ),
        KeychainDenied: (error) =>
          Effect.succeed(
            unknownObservations(
              machine,
              observedAt,
              "KeychainDenied",
              error.exitCode === null
                ? "the Keychain did not answer in time (locked, or waiting on a password prompt)"
                : `the Keychain refused access (security exited ${error.exitCode})`
            )
          ),
        TokenExpired: () =>
          Effect.succeed(
            unknownObservations(
              machine,
              observedAt,
              "AuthExpired",
              "the stored token expired; Claude Code renews it on its next use"
            )
          ),
        UsageFetchFailed: (error) =>
          Effect.succeed(unknownObservations(machine, observedAt, "Fetch", `request failed: ${error.cause}`))
      })
    )
  })
