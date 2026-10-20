import type { FleetLimits, FleetUsage } from "@knpkv/herdr-connect/usage"
import { DateTime, Schema } from "effect"
import type { DashboardSnapshot } from "../src/dashboard-model.js"

const windows: ReadonlyArray<"fiveHour" | "weekly"> = ["fiveHour", "weekly"]
const agents: ReadonlyArray<"claude" | "codex"> = ["claude", "codex"]
const Hour = Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 23 }))
const Minute = Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 59 }))
const ReadTime = Schema.TemplateLiteralParser([Hour, ":", Minute])
const ResetTime = Schema.TemplateLiteralParser([
  Schema.Literals(["Today", "Tuesday", "Wednesday"]),
  ", ",
  Hour,
  ":",
  Minute
])
const Window = Schema.Struct({ used: Schema.NullOr(Schema.Number), reset: Schema.NullOr(ResetTime) })
const Reading = Schema.Struct({
  tool: Schema.Literals(["claude", "codex"]),
  host: Schema.String,
  readAt: Schema.optionalKey(ReadTime),
  signIn: Schema.optionalKey(Schema.Boolean),
  fiveHour: Window,
  weekly: Window
}).check(
  Schema.makeFilter((reading) =>
    reading.readAt !== undefined || reading.signIn === true || "A reading needs its read time"
  )
)
const State = Schema.Struct({
  kind: Schema.optionalKey(Schema.Literals(["loading", "empty", "error"])),
  limits: Schema.optionalKey(Schema.Array(Reading)),
  chart: Schema.optionalKey(Schema.Literals(["all", "claudeOnly"])),
  shell: Schema.optionalKey(Schema.Struct({ approvals: Schema.Number }))
}).check(
  Schema.makeFilter((state) =>
    state.kind !== undefined || (state.limits !== undefined && state.chart !== undefined) ||
    "A reading state needs limits and chart"
  )
)
const UsageLimits = Schema.Struct({
  // Bind the wire clock to this export's date. A changed export date needs a reviewed clock update.
  meta: Schema.Struct({ date: Schema.Literal("Sunday 11 October 2026") }),
  shell: Schema.Struct({ hubHost: Schema.String, approvals: Schema.Number }),
  hosts: Schema.Array(Schema.Struct({ id: Schema.String })),
  tokens: Schema.Struct({
    host: Schema.String,
    days: Schema.Array(Schema.Struct({ day: Schema.String, claude: Schema.Number, codex: Schema.Number }))
  }),
  states: Schema.Record(Schema.String, State)
})
export const UsageDesignFixture = Schema.Struct({ usageLimits: UsageLimits })

const day = 86_400_000
const fixtureDay = DateTime.makeUnsafe("2026-10-11T00:00:00.000Z").epochMilliseconds
/** The export's latest 14:02 reading is the host's fixed sampling time, independent of the browser clock. */
export const fixtureNow = fixtureDay + (14 * 60 + 2) * 60_000
const resetOffsets = { Today: 0, Tuesday: 2, Wednesday: 3 }
const observedAt = (reading: typeof Reading.Type): number =>
  reading.readAt === undefined ? fixtureNow : fixtureDay + (reading.readAt[0] * 60 + reading.readAt[2]) * 60_000
const resetsAt = (window: typeof Window.Type): number | null =>
  window.reset === null
    ? null
    : fixtureDay + resetOffsets[window.reset[0]] * day + (window.reset[2] * 60 + window.reset[4]) * 60_000

/** Translate the official export's readings into the application's existing wire contract. */
export const designReadings = (fixture: typeof UsageDesignFixture.Type, state: typeof State.Type) => {
  const data = fixture.usageLimits
  const latest: FleetLimits["hosts"][number]["reading"] = {
    _tag: "Read",
    skipped: 0,
    limits: {
      v: 1,
      machine: data.tokens.host,
      observedAt: fixtureNow,
      latest: (state.limits ?? []).flatMap((reading) =>
        windows.map((window) => ({
          agent: reading.tool,
          machine: reading.host,
          source: reading.tool === "claude" ? "claude-oauth-usage" : "codex-rollout",
          label: window === "fiveHour" ? "five_hour" : "seven_day",
          windowMinutes: window === "fiveHour" ? 300 : 10_080,
          observedAt: observedAt(reading),
          reading: reading.signIn === true || reading[window].used === null
            ? { _tag: "Unknown", reason: "AuthExpired" }
            : { _tag: "Known", usedPercent: reading[window].used, resetsAt: resetsAt(reading[window]) }
        }))
      )
    }
  }
  const limits: FleetLimits = {
    hosts: [{ host: data.tokens.host, readAt: fixtureNow, reading: latest }],
    failures: [],
    peersListed: true
  }
  const from = fixtureDay - data.tokens.days.length * day
  const periods = data.tokens.days.map((_, index) => ({ key: String(from + index * day), start: from + index * day }))
  const usage: FleetUsage = {
    hosts: [{
      host: data.tokens.host,
      readAt: fixtureNow,
      reading: {
        _tag: "Read",
        skipped: 0,
        usage: {
          v: 1,
          machine: data.tokens.host,
          observedAt: fixtureNow,
          range: { preset: "7d", timeZone: "UTC", from, to: fixtureDay, bucket: "day" },
          periods,
          tokens: state.kind === "empty" ?
            [] :
            data.tokens.days.flatMap((entry, period) =>
              agents.flatMap((agent) =>
                state.chart === "claudeOnly" && agent === "codex"
                  ? []
                  : [{ period, agent, model: `${agent}-model`, tokens: entry[agent] * 1_000_000 }]
              )
            ),
          limits: []
        }
      }
    }],
    failures: [],
    peersListed: true
  }
  return { limits, usage }
}

/** Bootstrap the real client without a host, provider, persisted account or agent process. */
export const designDashboard = (
  fixture: typeof UsageDesignFixture.Type,
  state: typeof State.Type
): DashboardSnapshot => {
  const data = fixture.usageLimits
  const host = data.shell.hubHost
  const approvals = Array.from({ length: state.shell?.approvals ?? data.shell.approvals }, (_, index) => ({
    id: `123456789012-${index + 1}`,
    actor: "Requester",
    status: "pending_approval",
    payload: { kind: "nix.apply", ref: "main" },
    approvalAvailable: true,
    approvalExpiresAt: fixtureNow + 600_000,
    approvedAt: null,
    approvedBy: null,
    createdAt: fixtureNow,
    expiredAt: null,
    rejectedAt: null,
    rejectedBy: null,
    updatedAt: fixtureNow
  } satisfies DashboardSnapshot["pendingApprovals"]["local"][number]))
  return {
    host,
    observedAt: fixtureNow,
    approvalsEnabled: true,
    approvalApp: { canonical: true, canonicalUrl: "/", pushEnabled: false, workEnabled: false, sandboxesEnabled: true },
    work: null,
    status: {
      host,
      applyConfigured: false,
      branch: "main",
      dirty: false,
      repository: "fixture",
      revision: "123456789012",
      herdr: { agents: [], available: true, error: null }
    },
    records: [],
    historyNextCursor: null,
    directory: {
      currentUrl: "/",
      links: data.hosts.filter((entry) => entry.id !== host).map((entry) => ({
        host: entry.id,
        online: true,
        url: null
      })),
      error: null
    },
    pendingApprovals: { local: approvals, remote: [], failures: [], nextCursors: [] }
  }
}
