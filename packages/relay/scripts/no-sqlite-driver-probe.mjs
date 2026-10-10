/**
 * Run under Node by `test-packed-package.mjs`, with `node:sqlite` blocked by a module hook: when no SQLite
 * driver can load, the store fails with `RelayStoreFailed` whose message keeps the Node failure, not only
 * "Cannot find module bun:sqlite". No model turn runs, so the backend is a stub.
 *
 * Usage: node scripts/no-sqlite-driver-probe.mjs <bundle> <directory>
 */
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import console from "node:console"
import { registerHooks } from "node:module"
import { join } from "node:path"
import process from "node:process"

const sentinel = "probe: node:sqlite is blocked"
registerHooks({
  resolve: (specifier, context, next) => {
    if (specifier === "node:sqlite") throw new Error(sentinel)
    return next(specifier, context)
  }
})

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

const failure = await Effect.runPromise(
  Effect.scoped(make(options)).pipe(Effect.flip, Effect.provide(NodeServices.layer))
)
if (failure._tag !== "RelayStoreFailed" || !failure.message.includes(sentinel)) {
  console.error(`expected RelayStoreFailed naming the node:sqlite failure, got ${failure._tag}: ${failure.message}`)
  process.exit(1)
}
console.log("No SQLite driver: RelayStoreFailed keeps the node:sqlite failure")
