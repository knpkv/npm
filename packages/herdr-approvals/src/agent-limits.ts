import { collectBoundedText } from "@knpkv/bounded-io"
import { decodeBoundedResponseJson } from "@knpkv/herdr-fleet"
import { Clock, Duration, Effect, Ref, Result, Schema, type Scope } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** A failure's detail is the CLI's stderr; it is cut so a noisy host cannot bloat every snapshot. */
export const limitsDetailMaxLength = 512

/**
 * Claude and Codex subscription windows, as `agent-limits --json` reports them (contract v1).
 * A window the CLI cannot read is `Unknown` with a reason, never a zero; the hub keeps that
 * distinction all the way to the page.
 */
const Reading = <A extends Schema.Top>(value: A) =>
  Schema.Union([
    Schema.TaggedStruct("Known", { value }),
    // Reasons are words the CLI may add to; an unfamiliar one is still an unknown reading.
    Schema.TaggedStruct("Unknown", { reason: Schema.String })
  ])

export const LimitWindowId = Schema.Union([
  Schema.Literals(["five_hour", "weekly"]),
  Schema.Struct({ other: Schema.Number })
])
export type LimitWindowId = typeof LimitWindowId.Type

export const LimitWindowState = Schema.Union([
  Schema.TaggedStruct("Known", {
    usedPercent: Schema.Number,
    resetsAt: Schema.NullOr(Schema.Number),
    observedAt: Schema.Number,
    ageMs: Schema.Number,
    burnPerHour: Reading(Schema.Number),
    exhaustsAt: Reading(Schema.Union([Schema.Number, Schema.Literal("NotBeforeReset")])),
    source: Schema.String
  }),
  Schema.TaggedStruct("NotReported", {}),
  Schema.TaggedStruct("Unknown", {
    reason: Schema.String,
    observedAt: Schema.optionalKey(Schema.Number),
    ageMs: Schema.optionalKey(Schema.Number)
  })
])
export type LimitWindowState = typeof LimitWindowState.Type

/** The subscription a provider's windows belong to; `label` is for people (an email), `id` for grouping. */
export const LimitAccount = Schema.Union([
  Schema.TaggedStruct("Known", { id: Schema.String, label: Schema.String }),
  Schema.TaggedStruct("Unknown", { reason: Schema.String })
])
export type LimitAccount = typeof LimitAccount.Type

export const LimitProvider = Schema.Struct({
  reservePp: Schema.Number,
  // Added after v1 shipped; a CLI that predates it reports no account.
  account: Schema.optionalKey(LimitAccount),
  windows: Schema.Array(Schema.Struct({ window: LimitWindowId, state: LimitWindowState }))
})
export type LimitProvider = typeof LimitProvider.Type

export const AgentLimits = Schema.Struct({
  v: Schema.Literal(1),
  now: Schema.Number,
  providers: Schema.Struct({ claude: LimitProvider, codex: LimitProvider })
})
export type AgentLimits = typeof AgentLimits.Type

/** Why a host has no limits to show; the page says which, rather than drawing an empty meter. */
export const LimitsUnavailableReason = Schema.Literals([
  "not_configured",
  "failed",
  "timeout",
  "unsupported_version",
  "invalid_output"
])
export type LimitsUnavailableReason = typeof LimitsUnavailableReason.Type

/** One host's latest read: the CLI's report, or why there is none. `readAt` is when this host ran it. */
export const HostLimits = Schema.Struct({
  host: Schema.String,
  readAt: Schema.Number,
  reading: Schema.Union([
    Schema.TaggedStruct("Read", { limits: AgentLimits }),
    Schema.TaggedStruct("Unavailable", {
      reason: LimitsUnavailableReason,
      detail: Schema.String.check(Schema.isMaxLength(limitsDetailMaxLength))
    })
  ])
})
export type HostLimits = typeof HostLimits.Type

export const PeerLimitsFailureReason = Schema.Literals([
  "offline",
  "unavailable",
  "timeout",
  "request_failed",
  "invalid_response"
])

/**
 * Every host the hub could ask, and the ones it could not reach, by name. `peersListed` is false
 * when the hub could not list the fleet at all: `hosts` is then only its own read, and the page
 * says the other machines are unknown rather than implying there are none.
 */
export const FleetLimits = Schema.Struct({
  hosts: Schema.Array(HostLimits),
  failures: Schema.Array(Schema.Struct({ host: Schema.String, reason: PeerLimitsFailureReason })),
  peersListed: Schema.Boolean
})
export type FleetLimits = typeof FleetLimits.Type

export class PeerLimitsError extends Schema.TaggedError<PeerLimitsError>()("PeerLimitsError", {
  cause: Schema.Defect(),
  host: Schema.String,
  reason: PeerLimitsFailureReason
}) {}

/** The CLI's report is a few KiB; anything near this is not the contract. */
export const agentLimitsOutputMaxBytes = 256 * 1024
export const agentLimitsTimeout = "10 seconds"

const VersionProbe = Schema.Struct({ v: Schema.Unknown })

const unavailable = (reason: LimitsUnavailableReason, detail: string): HostLimits["reading"] => ({
  _tag: "Unavailable",
  reason,
  detail: detail.trim().slice(0, limitsDetailMaxLength)
})

class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", { detail: Schema.String }) {}

const runJson = Effect.fn("AgentLimits.run")(function*(command: readonly [string, ...Array<string>]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* Effect.scoped(
    Effect.gen(function*() {
      const handle = yield* spawner.spawn(ChildProcess.make(command[0], command.slice(1)))
      const { exitCode, stderr, stdout } = yield* Effect.all({
        exitCode: handle.exitCode,
        stderr: collectBoundedText(handle.stderr, agentLimitsOutputMaxBytes),
        stdout: collectBoundedText(handle.stdout, agentLimitsOutputMaxBytes)
      }, { concurrency: "unbounded" })
      if (Number(exitCode) !== 0) {
        return yield* new CommandFailed({
          detail: stderr.trim() === "" ? `exited with code ${String(exitCode)}` : stderr
        })
      }
      return stdout
    })
  ).pipe(
    Effect.catchTags({
      ByteLimitExceeded: () => Effect.fail(new CommandFailed({ detail: "output over the size limit" }))
    }),
    Effect.mapError((error) => error._tag === "CommandFailed" ? error : new CommandFailed({ detail: String(error) }))
  )
})

/**
 * Runs the configured `agent-limits` command once and reports what it said. Never fails: a missing
 * command, a crash, a timeout, a newer contract or output that is not the contract each become
 * `Unavailable` with its own reason, so one broken host cannot blank the fleet view.
 */
export const readAgentLimits = Effect.fn("AgentLimits.read")(function*(
  host: string,
  command: ReadonlyArray<string> | undefined
) {
  const reading = yield* readReading(command)
  return { host, readAt: yield* Clock.currentTimeMillis, reading } satisfies HostLimits
})

const readReading = (command: ReadonlyArray<string> | undefined) => {
  const executable = command?.[0]
  if (command === undefined || executable === undefined) {
    return Effect.succeed(unavailable("not_configured", "agentLimitsCommand is not set for this host"))
  }
  return runJson([executable, ...command.slice(1)]).pipe(
    Effect.timeoutOrElse({
      duration: agentLimitsTimeout,
      orElse: () => Effect.succeed(null)
    }),
    Effect.map((stdout): HostLimits["reading"] => {
      if (stdout === null) return unavailable("timeout", `no answer within ${agentLimitsTimeout}`)
      const parsed = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))(stdout)
      if (Result.isFailure(parsed)) return unavailable("invalid_output", "output is not JSON")
      const probe = Schema.decodeUnknownResult(VersionProbe)(parsed.success)
      if (Result.isSuccess(probe) && probe.success.v !== 1) {
        return unavailable("unsupported_version", `contract v${String(probe.success.v)}; this hub reads v1`)
      }
      const limits = Schema.decodeUnknownResult(AgentLimits)(parsed.success)
      return Result.isSuccess(limits)
        ? { _tag: "Read", limits: limits.success }
        : unavailable("invalid_output", String(limits.failure))
    }),
    Effect.catchTag("CommandFailed", ({ detail }) => Effect.succeed(unavailable("failed", detail)))
  )
}

export interface PeerLimitsTarget {
  readonly host: string
  readonly online: boolean
  readonly limitsUrl: string | null
}

const peerLimitsTimeoutMs = 1_500

/** One peer's own read, from its tailnet listener. The answer must name the peer it came from. */
export const fetchPeerLimits = Effect.fn("AgentLimits.fetchPeer")(
  function*(peer: PeerLimitsTarget) {
    if (!peer.online) return yield* new PeerLimitsError({ cause: peer.host, host: peer.host, reason: "offline" })
    if (peer.limitsUrl === null) {
      return yield* new PeerLimitsError({ cause: peer.host, host: peer.host, reason: "unavailable" })
    }
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(peer.limitsUrl).pipe(
      Effect.mapError((cause) => new PeerLimitsError({ cause, host: peer.host, reason: "request_failed" }))
    )
    if (response.status < 200 || response.status >= 300) {
      return yield* new PeerLimitsError({ cause: response.status, host: peer.host, reason: "request_failed" })
    }
    const limits = yield* decodeBoundedResponseJson(response, HostLimits).pipe(
      Effect.mapError((cause) => new PeerLimitsError({ cause, host: peer.host, reason: "invalid_response" }))
    )
    if (limits.host.toLowerCase() !== peer.host.toLowerCase()) {
      return yield* new PeerLimitsError({ cause: limits.host, host: peer.host, reason: "invalid_response" })
    }
    return limits
  },
  (effect, peer) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: peerLimitsTimeoutMs,
        orElse: () =>
          Effect.fail(new PeerLimitsError({ cause: peerLimitsTimeoutMs, host: peer.host, reason: "timeout" }))
      })
    )
)

/** This host's read plus every peer's, asked four at a time; an unreachable peer is listed, not dropped. */
export const fleetLimits = Effect.fn("AgentLimits.fleet")(function*(
  local: Effect.Effect<HostLimits>,
  peers: ReadonlyArray<PeerLimitsTarget>
) {
  const own = yield* local
  const results = yield* Effect.all(
    peers.map((peer) => Effect.result(fetchPeerLimits(peer)).pipe(Effect.map((result) => ({ peer, result })))),
    { concurrency: 4 }
  )
  const hosts: Array<HostLimits> = [own]
  const failures: Array<FleetLimits["failures"][number]> = []
  for (const { peer, result } of results) {
    if (Result.isSuccess(result)) hosts.push(result.success)
    else failures.push({ host: peer.host, reason: result.failure.reason })
  }
  return { hosts, failures, peersListed: true } satisfies FleetLimits
})

/**
 * The hub's view: its own read plus every peer it can list. When listing the fleet fails (for
 * example `tailscale status`), it still answers with its own read and `peersListed: false`.
 */
export const hubLimits = Effect.fn("AgentLimits.hub")(function*<E, R>(
  local: Effect.Effect<HostLimits>,
  peers: Effect.Effect<ReadonlyArray<PeerLimitsTarget>, E, R>
) {
  const listed = yield* Effect.result(peers)
  if (Result.isSuccess(listed)) return yield* fleetLimits(local, listed.success)
  return { hosts: [yield* local], failures: [], peersListed: false } satisfies FleetLimits
})

/**
 * Serves `read`'s last value and refreshes it in the background once it is older than `ttl`, so a
 * caller never waits on a slow read after the first. Only the first call blocks, and concurrent
 * first calls share that one read. At most one refresh runs at a time; it lives in the caller's
 * scope, so closing the scope stops it.
 */
export const staleWhileRevalidate = Effect.fn("AgentLimits.staleWhileRevalidate")(function*<A>(
  read: Effect.Effect<A>,
  ttl: Duration.Duration
) {
  const scope: Scope.Scope = yield* Effect.scope
  const ttlMillis = Duration.toMillis(ttl)
  const latest = yield* Ref.make<{ readonly value: A; readonly at: number } | null>(null)
  const refreshing = yield* Ref.make(false)
  const refresh = Effect.gen(function*() {
    const value = yield* read
    yield* Ref.set(latest, { value, at: yield* Clock.currentTimeMillis })
    return value
  })
  const first = yield* Effect.cached(refresh)
  return Effect.gen(function*() {
    const current = yield* Ref.get(latest)
    if (current === null) return yield* first
    if ((yield* Clock.currentTimeMillis) - current.at >= ttlMillis && !(yield* Ref.getAndSet(refreshing, true))) {
      yield* Effect.forkIn(refresh.pipe(Effect.ensuring(Ref.set(refreshing, false))), scope)
    }
    return current.value
  })
})
