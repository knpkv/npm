#!/usr/bin/env node
/**
 * Starts each workspace executable under plain Node, the way `pnpm link --global` runs it, and fails
 * when one cannot load. A workspace package that resolves to TypeScript sources only works through
 * tsx or Bun, so its linked executable used to crash with ERR_MODULE_NOT_FOUND before printing a
 * line. Each case waits for a line only the program itself prints, on stdout or stderr, which proves
 * its whole import graph resolved. Run after `pnpm build`; an executable that is not built is
 * reported as one "build … first" line.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Stream from "effect/Stream"
import { createServer } from "node:net"

import { packagesRoot, workspacePackages } from "./workspace-manifests.mjs"

class BinsFailed extends Data.TaggedError("BinsFailed") {}

/** A free loopback port, for executables that serve. */
const freePort = Effect.callback((resume) => {
  const probe = createServer()
  probe.once("error", (error) =>
    resume(Effect.fail(new BinsFailed({ reason: `no free loopback port: ${error.message}` })))
  )
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address()
    probe.close(() =>
      resume(
        address === null || Predicate.isString(address)
          ? Effect.fail(new BinsFailed({ reason: "the port probe had no address" }))
          : Effect.succeed(address.port)
      )
    )
  })
})

/**
 * Each case's ready line names its program, so Node's own crash trailer ("Node.js v24.0.0") never
 * matches.
 */
const cases = [
  { name: "codecommit", bin: "codecommit/dist/src/bin.js", args: ["--version"], ready: /^codecommit v\d+\.\d+\.\d+$/ },
  { name: "jcf", bin: "jira-clockify/dist/src/bin.js", args: ["--version"], ready: /^jcf v\d+\.\d+\.\d+$/ },
  { name: "agent-usage", bin: "agent-usage/dist/main.js", args: ["--version"], ready: /^agent-usage v\d+\.\d+\.\d+$/ },
  {
    name: "jcf-web",
    bin: "jcf-web/dist/main.js",
    args: [],
    ready: /^jcf week view: http:\/\/127\.0\.0\.1:\d+\//,
    env: (port) => ({ PORT: String(port) })
  },
  { name: "codecommit-mock", bin: "codecommit-mock/dist/cli.js", args: [], ready: /^CodeCommit mock listening at / },
  // An argument it does not take: it prints its usage and exits without touching any state.
  {
    name: "control-center",
    bin: "control-center/dist/server/server/cli.js",
    args: ["--version"],
    ready: /^Usage: control-center /
  }
]

const lines = (bytes) => Stream.splitLines(Stream.decodeText(bytes))

/** `undefined` once the case prints its ready line, or why it did not with its last output. */
const runCase = (binCase) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = yield* packagesRoot
      const bin = path.join(root, binCase.bin)
      if (!(yield* fs.exists(bin))) {
        const packages = yield* workspacePackages
        const owner = packages.find(({ directory }) => bin.startsWith(`${directory}${path.sep}`))
        const name = owner?.manifest.name ?? binCase.bin
        return `build ${name} first: pnpm --filter "${name}..." build`
      }
      const home = yield* fs.makeTempDirectoryScoped({ prefix: `workspace-bin-${binCase.name}-` })
      const port = yield* freePort
      const child = yield* Effect.acquireRelease(
        spawner.spawn(
          ChildProcess.make("node", [bin, ...binCase.args], {
            // Run from outside the repository, as a globally linked executable is, with only home and
            // port isolated from the caller's environment.
            cwd: home,
            env: { HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, ...binCase.env?.(port) },
            extendEnv: true,
            stdout: "pipe",
            stderr: "pipe"
          })
        ),
        (handle) => handle.kill().pipe(Effect.ignore)
      )
      const seen = yield* Stream.merge(lines(child.stdout), lines(child.stderr)).pipe(
        Stream.takeUntil((line) => binCase.ready.test(line)),
        Stream.runCollect,
        Effect.timeoutOption("60 seconds")
      )
      const output = Option.getOrElse(seen, () => [])
      if (output.some((line) => binCase.ready.test(line))) return undefined
      const reason = Option.isNone(seen)
        ? "printed no ready line within 60 seconds"
        : "exited before printing its ready line"
      return `${reason}:\n${output.slice(-6).join("\n")}`
    })
  )

const program = Effect.gen(function* () {
  const failures = []
  for (const binCase of cases) {
    const reason = yield* runCase(binCase).pipe(Effect.catch((error) => Effect.succeed(error.message ?? String(error))))
    if (reason === undefined) yield* Console.log(`${binCase.name}: loads under Node`)
    else failures.push(`${binCase.name} (${binCase.bin}) ${reason}`)
  }
  if (failures.length > 0) return yield* new BinsFailed({ reason: failures.join("\n") })
})

// Report the failures alone (no stack), then exit non-zero.
const main = program.pipe(
  Effect.tapError((error) => (error._tag === "BinsFailed" ? Console.error(error.reason) : Console.error(error))),
  Effect.provide(NodeServices.layer)
)

if (import.meta.main) NodeRuntime.runMain(main, { disableErrorReporting: true })
