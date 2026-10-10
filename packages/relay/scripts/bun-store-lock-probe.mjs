/**
 * Run under Bun by `test-packed-package.mjs`: the built bundle's store lock, on Bun's SQLite, refuses a second
 * owner with `RelayStoreLocked` and frees the store when its scope closes, so the same process opens it again.
 * No model turn runs, so the backend is a stub.
 *
 * Usage: bun scripts/bun-store-lock-probe.mjs <bundle> <directory>
 */
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import console from "node:console"
import { join } from "node:path"
import process from "node:process"

const [bundle, directory] = process.argv.slice(2)
const { make } = await import(bundle)
const backend = {
  id: "claude-code",
  name: "Claude Code",
  model: Layer.empty,
  probe: Effect.succeed("probe"),
  signInFix: "unused"
}
const options = {
  storePath: join(directory, "sessions.sqlite"),
  instructions: "Probe.",
  capabilities: [],
  backends: [backend]
}

const program = Effect.gen(function* () {
  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* make(options)
      const second = yield* Effect.scoped(make(options)).pipe(Effect.flip)
      if (second._tag !== "RelayStoreLocked") {
        return yield* Effect.die(`a second owner got ${second._tag}: ${second.message}`)
      }
    })
  )
  yield* Effect.scoped(make(options))
})

await Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer)))
console.log("Bun store lock: refused a second owner as RelayStoreLocked, reopened after close")
