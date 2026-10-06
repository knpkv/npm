/**
 * The documented way to run jcf-web from a checkout works: `pnpm start` in this package.
 *
 * It runs with a fresh, empty HOME on a free loopback port, must print the one-time URL within a
 * minute, and must serve the built client at that origin. Run after `pnpm build`, as the README says.
 */
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Console, Effect, FileSystem, Option, Path, Predicate, Schema, Stream } from "effect"
import { HttpClient } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { createServer } from "node:net"

class WorkspaceStartError extends Schema.TaggedError<WorkspaceStartError>()("WorkspaceStartError", {
  message: Schema.String
}) {}

/** A port the kernel just handed out, released so the server can take it. */
const availableLoopbackPort = Effect.callback<number, WorkspaceStartError>((resume) => {
  const probe = createServer()
  probe.once("error", () => resume(Effect.fail(new WorkspaceStartError({ message: "No free loopback port" }))))
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address()
    probe.close(() =>
      resume(
        address === null || Predicate.isString(address)
          ? Effect.fail(new WorkspaceStartError({ message: "The port probe had no address" }))
          : Effect.succeed(address.port)
      )
    )
  })
})

const program = Effect.scoped(
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const packageRoot = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "jcf-web-start-" })
    const port = yield* availableLoopbackPort
    const pathVariable = yield* Config.String("PATH")

    const child = yield* Effect.acquireRelease(
      spawner.spawn(ChildProcess.make("pnpm", ["start"], {
        cwd: packageRoot,
        env: { HOME: home, XDG_CONFIG_HOME: home, PATH: pathVariable, PORT: String(port) },
        extendEnv: false,
        stdout: "pipe",
        stderr: "inherit"
      })),
      (handle) => handle.kill().pipe(Effect.ignore)
    ).pipe(Effect.mapError(() => new WorkspaceStartError({ message: "pnpm start could not run" })))

    const line = yield* Stream.decodeText(child.stdout).pipe(
      Stream.splitLines,
      Stream.filter((text) => text.startsWith("jcf week view: ")),
      Stream.runHead,
      Effect.timeout("60 seconds"),
      Effect.mapError(() => new WorkspaceStartError({ message: "pnpm start printed no URL within a minute" }))
    )
    if (Option.isNone(line)) {
      return yield* new WorkspaceStartError({ message: "pnpm start exited before printing its URL" })
    }
    const advertised = new URL(line.value.slice("jcf week view: ".length))
    if (advertised.origin !== `http://127.0.0.1:${port}` || advertised.hash === "") {
      return yield* new WorkspaceStartError({
        message: `pnpm start printed an unexpected URL origin: ${advertised.origin}`
      })
    }
    const response = yield* HttpClient.get(advertised.origin)
    const html = yield* response.text
    if (response.status !== 200 || !html.includes("id=\"root\"")) {
      return yield* new WorkspaceStartError({ message: `GET / answered ${response.status} without the client` })
    }
    yield* Console.log("pnpm start in the workspace prints its URL and serves the client")
  })
)

// This script is its own entry point.
NodeRuntime.runMain(program.pipe(Effect.provide([NodeServices.layer, NodeHttpClient.layerFetch])))
