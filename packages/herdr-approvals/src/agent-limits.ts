import { collectBoundedText } from "@knpkv/bounded-io"
import { decodeBoundedResponseJson } from "@knpkv/herdr-fleet/response"
import { Clock, Effect, Result, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import {
  AgentLimits,
  type FleetLimits,
  HostLimits,
  limitsDetailMaxLength,
  type LimitsUnavailableReason,
  PeerLimitsFailureReason
} from "./limits-schema.js"

export * from "./limits-schema.js"

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
  return { hosts, failures } satisfies FleetLimits
})
