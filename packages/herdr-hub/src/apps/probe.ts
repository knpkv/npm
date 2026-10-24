/**
 * Runs a freshly installed app once, before `apps.json` names it, and reads its manifest.
 *
 * Mental model:
 * - **The real start, on a throwaway endpoint.** The app gets the same stdin handshake the supervisor sends, with a
 *   hub URL that answers nothing and tokens nothing accepts: serving `/app/manifest` needs neither. Its endpoint is
 *   in a directory prepared by the supervisor's own rules (`prepareEndpointPlace`), never `$TMPDIR` as is.
 * - **Bounded.** It must answer within the deadline; then stdin closes, and the spawner kills it if it hasn't exited.
 * - **The manifest decides the id.** The installer compares it with the package's `hubApp` field afterwards.
 *
 * @since 0.1.0
 */
import { AppId, AppManifest, appPaths, hubHeaders } from "@knpkv/hub-app"
import { Clock, Crypto, Duration, Effect, Fiber, Queue, Schema, Stream } from "effect"
import type { Cause } from "effect"
import { Base64Url, Hex } from "effect/encoding"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { AppInstallFailed } from "./npm.js"
import { getJson } from "./socket.js"
import { endpointFor, type EndpointPlace } from "./supervisor.js"

export interface ProbeOptions {
  readonly package: string
  /** The node that will run the app (the CLI's `process.execPath`). */
  readonly node: string
  /** The script, already checked to be inside its directory. */
  readonly script: string
  readonly cwd: string
  readonly place: EndpointPlace
  /** The heap cap the hub will start it with (`--max-old-space-size`), so an app that can't run under it fails here. */
  readonly memoryMb: number
  /** How long the app has to answer its manifest; 10 s by default. */
  readonly deadline?: Duration.Duration
}

const probeId = AppId.make("probe")

/** The app's manifest, or `AppInstallFailed{probe}` when it exits, never answers, or answers unreadably. */
export const probeApp = Effect.fn("AppProbe.run")(function*(options: ProbeOptions) {
  const cryptoService = yield* Crypto.Crypto
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const failed = (detail: string) => new AppInstallFailed({ package: options.package, stage: "probe", detail })
  const nonce = Hex.encode(yield* cryptoService.randomBytes(16))
  const endpoint = endpointFor(options.place, probeId, nonce)
  const secret = Base64Url.encode(yield* cryptoService.randomBytes(32))
  const handshake = `${
    JSON.stringify({
      v: 1,
      endpoint,
      hubUrl: "http://127.0.0.1:9",
      hubToken: Base64Url.encode(yield* cryptoService.randomBytes(32)),
      appSecret: secret
    })
  }\n`
  const stdin = yield* Queue.unbounded<Uint8Array, Cause.Done>()
  yield* Queue.offer(stdin, new TextEncoder().encode(handshake))
  const child = yield* spawner.spawn(ChildProcess.make(options.node, [
    `--max-old-space-size=${options.memoryMb}`,
    options.script,
    "--attach"
  ], {
    cwd: options.cwd,
    shell: false,
    stdin: { stream: Stream.fromQueue(stdin), endOnDone: true },
    stdout: "ignore",
    stderr: "ignore",
    killSignal: "SIGKILL"
  })).pipe(Effect.mapError((error) => failed(error.message)))
  // Closing stdin is the app's stop signal; the spawner's finalizer kills whatever is left.
  yield* Effect.addFinalizer(() => Queue.end(stdin))

  const read = getJson(endpoint, appPaths.manifest, 1_000, { [hubHeaders.appSecret]: secret }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AppManifest))
  )
  const answered = Effect.gen(function*() {
    const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(options.deadline ?? Duration.seconds(10))
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const attempt = yield* read.pipe(Effect.result)
      if (attempt._tag === "Success") return attempt.success
      if (attempt.failure._tag === "SchemaError") return yield* failed("its manifest does not decode")
      yield* Effect.sleep(100)
    }
    return yield* failed("it did not answer in time")
  })
  const exited = yield* Effect.forkScoped(child.exitCode)
  return yield* Effect.raceFirst(
    answered,
    Fiber.join(exited).pipe(
      Effect.mapError((error) => failed(error.message)),
      Effect.flatMap((code) => Effect.fail(failed(`it exited with code ${code} before answering`)))
    )
  )
}, Effect.scoped)
