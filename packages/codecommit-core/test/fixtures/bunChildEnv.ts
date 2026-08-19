/**
 * Bun-hosted probe for `ChildEnv.profileScopedEnv`.
 *
 * The sibling test runs under Node, so spawning `bun` from it only proves that
 * *Node's* spawner clears the ambient variables before handing them to a Bun
 * child. Under Bun the same spawner code runs against Bun's own
 * `node:child_process` reimplementation, and that is the path the TUI's `assume`
 * spawn actually takes.
 *
 * `@effect/platform-bun`'s `BunChildProcessSpawner` re-exports
 * `NodeChildProcessSpawner` verbatim, so `NodeServices.layer` provides the very
 * same spawner `BunServices.layer` would. What this fixture adds is the Bun
 * *host*, not a different layer.
 *
 * Invoked as `bun bunChildEnv.ts`. The grandchild inherits stdout, so its
 * environment JSON reaches the test without this fixture printing anything.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as ChildEnv from "../../src/ChildEnv.js"

const program = Effect.gen(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  yield* spawner.exitCode(
    ChildProcess.make("bun", ["-e", "process.stdout.write(JSON.stringify(process.env))"], {
      env: ChildEnv.profileScopedEnv(process.env, { AWS_PROFILE: "target-profile" }),
      extendEnv: true,
      stdout: "inherit"
    })
  )
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

await Effect.runPromise(program).catch((cause: unknown) => {
  // Surface the failure through stderr and a non-zero exit so the test reports a
  // decode failure against real output rather than an empty success.
  throw cause
})
