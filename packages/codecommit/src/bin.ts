import { Command, Options } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import open from "open"
import { makeServer } from "@knpkv/codecommit-web"

// TUI Command
const tui = Command.make("tui", {}, () => 
  Effect.gen(function* () {
    yield* Effect.promise(() => import("./main.js"))
  })
)

// Web Command
const web = Command.make("web", {
  port: Options.integer("port").pipe(Options.withDefault(3000)),
  hostname: Options.text("hostname").pipe(Options.withDefault("127.0.0.1"))
}, ({ port, hostname }) =>
  Effect.gen(function* () {
    yield* Effect.logInfo(`Starting web server at http://${hostname}:${port}`)

    // Open browser
    yield* Effect.promise(() => open(`http://${hostname}:${port}`))

    // Run server with configured port/hostname
    yield* Layer.launch(makeServer({ port, hostname }))
  })
)

const command = Command.make("codecommit", {}, () => 
  // Default to TUI if no subcommand
  Effect.promise(() => import("./main.js"))
).pipe(
  Command.withSubcommands([tui, web])
)

const cli = Command.run(command, {
  name: "codecommit",
  version: "0.0.1"
})

Effect.suspend(() => cli(process.argv)).pipe(
  Effect.provide(BunContext.layer),
  BunRuntime.runMain
)
