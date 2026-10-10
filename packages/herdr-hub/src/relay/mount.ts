/**
 * Relay inside the Herdr hub: one harness for the hub's fleet conversation, started the first time someone
 * opens Relay.
 *
 * **Mental model**
 *
 * - **Relay never stops hostd.** `@knpkv/relay` (Pi, the SQLite driver) loads with a dynamic import inside
 *   the start, so a broken install, a store another hostd holds, or a directory that is a link makes every
 *   `/v1/relay` route answer {@link RelayUnavailableError} with the fix, while Approvals, Connect and Work
 *   keep running.
 * - **The server owns the start; a request only waits for it.** The first request forks the start into the
 *   server's scope, so a request that disconnects never cancels it, and closing the server closes the
 *   harness. A start that fails or is interrupted is forgotten, so the next request tries again: when the
 *   other hostd holding the store stops, the OS drops its lock and this one starts Relay without a restart.
 *   (Within one process, a closed harness does not yet release the store; reopening it there fails.)
 * - **Sessions are hostd's state.** `<stateDirectory>/relay/sessions.sqlite`, in an owner-only directory,
 *   which is also where the CLI backends start (every tool is withheld from them).
 *
 * @module
 */
import type * as Relay from "@knpkv/relay"
import { RelayUnavailableError } from "@knpkv/relay/wire"
import {
  type Crypto,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Predicate,
  Scope,
  SynchronizedRef
} from "effect"
import type { ChildProcessSpawner } from "effect/process"

/** The harness, or why it can't run on this host. */
export interface RelayHubMount {
  /** Starts Relay on first use and waits for it; fails with the fix when it can't run here. */
  readonly harness: Effect.Effect<Relay.RelayHarnessService, RelayUnavailableError>
}

/** The backends Relay runs turns on, given the module and the directory the CLIs start in. The first is the default. */
export type RelayHubBackends = (
  relay: typeof Relay,
  directory: string
) => Effect.Effect<
  readonly [Relay.RelayBackend, ...ReadonlyArray<Relay.RelayBackend>],
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
>

export interface RelayHubOptions {
  /** Owner-only directory for the session store; created on first start. */
  readonly directory: string
  readonly instructions: string
  /** The capabilities Relay may call, registered with the module once it has loaded. */
  readonly capabilities: (relay: typeof Relay) => ReadonlyArray<Relay.RegisteredCapability<never>>
  readonly backends: RelayHubBackends
}

/** Claude Code (the default) and Codex, each on the host's own CLI login. */
export const cliBackends: RelayHubBackends = Effect.fn("RelayHub.cliBackends")(function*(relay, directory) {
  const claude = yield* relay.claudeCodeBackend({ cwd: directory })
  const codex = yield* relay.codexCliBackend({ cwd: directory })
  const backends: readonly [Relay.RelayBackend, Relay.RelayBackend] = [claude, codex]
  return backends
})

const unavailable = (message: string, fix: string) => new RelayUnavailableError({ message, fix })

/** Builds the mount in the server's scope; nothing loads or opens until the first `harness`. */
export const makeRelayHubMount = Effect.fn("RelayHub.makeMount")(function*(options: RelayHubOptions) {
  const scope = yield* Scope.Scope
  const services = yield* Effect.context<
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
  >()
  const latch = yield* SynchronizedRef.make(
    Option.none<Deferred.Deferred<Relay.RelayHarnessService, RelayUnavailableError>>()
  )

  const start = Effect.gen(function*() {
    const relay = yield* Effect.tryPromise({
      try: () => import("@knpkv/relay"),
      catch: (cause) =>
        unavailable(
          `Relay could not load: ${Predicate.isError(cause) ? cause.message : String(cause)}`,
          "Reinstall herdr-hub so @knpkv/relay and its SQLite driver are present, then restart hostd."
        )
    })
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    // The CLIs start here before the store opens; the store refuses the directory if it is a link.
    yield* fileSystem.makeDirectory(options.directory, { recursive: true, mode: 0o700 })
    const backends = yield* options.backends(relay, options.directory)
    return yield* relay.make({
      storePath: path.join(options.directory, "sessions.sqlite"),
      instructions: options.instructions,
      capabilities: options.capabilities(relay),
      backends
    })
  }).pipe(
    Effect.catchTags({
      RelayStoreLocked: ({ message }) =>
        Effect.fail(unavailable(message, "Another hostd owns Relay's sessions. Stop it; the next request retries.")),
      RelayStoreLinked: ({ message }) =>
        Effect.fail(unavailable(message, `Replace ${options.directory} with a directory you own.`)),
      RelayStoreFailed: ({ message }) =>
        Effect.fail(unavailable(message, `Check that ${options.directory} is owned by you and writable.`)),
      PlatformError: (failure) =>
        Effect.logWarning("Relay could not prepare its directory", failure).pipe(
          Effect.andThen(
            Effect.fail(
              unavailable(
                "Relay could not prepare its data directory.",
                `Check that ${options.directory} is owned by you and writable.`
              )
            )
          )
        )
    }),
    Effect.provideService(Scope.Scope, scope),
    Effect.provide(services)
  )

  /** Forks the start into the server's scope; a failed or interrupted start clears the latch first. */
  const begin = Effect.gen(function*() {
    const started = yield* Deferred.make<Relay.RelayHarnessService, RelayUnavailableError>()
    yield* start.pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        (Exit.isSuccess(exit) ? Effect.void : SynchronizedRef.set(latch, Option.none())).pipe(
          Effect.andThen(Deferred.done(started, exit))
        )
      ),
      Effect.onInterrupt(() =>
        SynchronizedRef.set(latch, Option.none()).pipe(Effect.andThen(Deferred.interrupt(started)))
      ),
      Effect.forkIn(scope)
    )
    return started
  })

  type Started = Deferred.Deferred<Relay.RelayHarnessService, RelayUnavailableError>
  const harness = SynchronizedRef.modifyEffect(latch, (current) =>
    Option.match(current, {
      onSome: (started): Effect.Effect<readonly [Started, Option.Option<Started>]> =>
        Effect.succeed([started, current]),
      onNone: () =>
        Effect.map(begin, (started): readonly [Started, Option.Option<Started>] => [started, Option.some(started)])
    })).pipe(Effect.flatMap(Deferred.await))

  return { harness } satisfies RelayHubMount
})
