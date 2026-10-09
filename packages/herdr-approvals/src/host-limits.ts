/**
 * This host's Claude and Codex limits for Connect: hostd runs the configured
 * `agent-usage limits` command and serves its answer, refreshed in the background. The command
 * reads agent-usage's own store over its owner-only control socket, so no provider credential and
 * no session cookie passes through hostd.
 *
 * @module
 */
import { collectBoundedText } from "@knpkv/bounded-io"
import { decodeLimitsTolerantly, type HostLimits, limitsUnavailable, RawLimits, readingOf } from "@knpkv/herdr-connect"
import { Clock, Duration, Effect, Ref, Result, Schema, type Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { CommandFailed, reportFailure } from "./agent-usage-failure.js"

/** agent-usage's answer is a few KiB; anything near this is not it. */
export const hostLimitsOutputMaxBytes = 256 * 1024
export const hostLimitsTimeout = "10 seconds"

const decodeRawLimits = Schema.decodeUnknownResult(Schema.fromJsonString(RawLimits))

/** Runs an agent-usage command and answers its stdout, failing with its stderr when it exits nonzero. */
export const runCommand = Effect.fn("HostLimits.run")(function*(
  command: readonly [string, ...Array<string>],
  maxBytes: number = hostLimitsOutputMaxBytes
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* Effect.scoped(
    Effect.gen(function*() {
      const handle = yield* spawner.spawn(ChildProcess.make(command[0], command.slice(1)))
      const { exitCode, stderr, stdout } = yield* Effect.all({
        exitCode: handle.exitCode,
        stderr: collectBoundedText(handle.stderr, hostLimitsOutputMaxBytes),
        stdout: collectBoundedText(handle.stdout, maxBytes)
      }, { concurrency: "unbounded" })
      if (Number(exitCode) !== 0) {
        return yield* new CommandFailed({
          kind: "exit",
          detail: stderr.trim() === "" ? `exited with code ${String(exitCode)}` : stderr
        })
      }
      return stdout
    })
  ).pipe(
    Effect.catchTags({
      ByteLimitExceeded: () =>
        Effect.fail(new CommandFailed({ kind: "too_large", detail: "output over the size limit" }))
    }),
    Effect.mapError((error) =>
      error._tag === "CommandFailed" ? error : new CommandFailed({ kind: "spawn", detail: String(error) })
    )
  )
})

const readReading = (command: ReadonlyArray<string> | undefined): Effect.Effect<
  HostLimits["reading"],
  never,
  ChildProcessSpawner.ChildProcessSpawner
> => {
  const executable = command?.[0]
  if (command === undefined || executable === undefined) {
    return Effect.succeed(limitsUnavailable("not_configured", "agentUsageLimitsCommand is not set for this host"))
  }
  return runCommand([executable, ...command.slice(1)]).pipe(
    Effect.timeoutOrElse({ duration: hostLimitsTimeout, orElse: () => Effect.succeed(null) }),
    Effect.map((stdout): HostLimits["reading"] => {
      if (stdout === null) return limitsUnavailable("timeout", `no answer within ${hostLimitsTimeout}`)
      const json = decodeRawLimits(stdout.trim())
      if (Result.isFailure(json)) {
        return limitsUnavailable("invalid_output", "agent-usage printed something that is not a JSON object")
      }
      // A newer agent-usage may add sources or reasons: what this hostd can't read is skipped and counted.
      return readingOf(decodeLimitsTolerantly(json.success))
    }),
    // agent-usage's own sentence can name host paths: it is logged here, and a fixed sentence leaves.
    Effect.catchTag(
      "CommandFailed",
      (failure) =>
        Effect.map(reportFailure("Connect limits", failure), (sentence) => limitsUnavailable("failed", sentence))
    )
  )
}

/**
 * Runs the configured command once and reports what it said. Never fails: no command, a crash, a
 * timeout, a newer format (`unsupported_version`) or output that is not agent-usage's each become
 * `Unavailable` with its own reason, so one broken host cannot blank the fleet view.
 */
export const readHostLimits = Effect.fn("HostLimits.read")(function*(
  host: string,
  command: ReadonlyArray<string> | undefined
) {
  const reading = yield* readReading(command)
  return { host, readAt: yield* Clock.currentTimeMillis, reading } satisfies HostLimits
})

/** A value read through a cache: `read` answers at once after the first call. */
export interface StaleWhileRevalidate<A> {
  readonly read: Effect.Effect<A>
}

/**
 * Serves `read`'s last value and refreshes it in the background once it is older than `ttl`, so a
 * caller never waits on a slow read after the first. Only the first call blocks, and concurrent
 * first calls share that one read. At most one refresh runs at a time; it lives in the caller's
 * scope, so closing the scope stops it.
 */
export const staleWhileRevalidate = Effect.fn("HostLimits.staleWhileRevalidate")(function*<A>(
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
  const cached: StaleWhileRevalidate<A> = {
    read: Effect.gen(function*() {
      const current = yield* Ref.get(latest)
      if (current === null) return yield* first
      if ((yield* Clock.currentTimeMillis) - current.at >= ttlMillis && !(yield* Ref.getAndSet(refreshing, true))) {
        yield* Effect.forkIn(refresh.pipe(Effect.ensuring(Ref.set(refreshing, false))), scope)
      }
      return current.value
    })
  }
  return cached
})
