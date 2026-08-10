#!/usr/bin/env node
/**
 * CLI entry point for confluence-to-markdown.
 */
import { NodeRuntime, NodeStdio, NodeTerminal } from "@effect/platform-node"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stdio from "effect/Stdio"
import { Command } from "effect/unstable/cli"
import pkg from "../package.json" with { type: "json" }
import { handleError } from "./commands/errorHandler.js"
import { AppLayer, AuthOnlyLayer, CloneLayer, FetchLayer, getLayerType, MinimalLayer } from "./commands/layers.js"
import { confluenceCommand } from "./commands/root.js"

// === Run CLI ===
const cli = Command.runWith(confluenceCommand, {
  version: pkg.version
})

/**
 * Provide inside each branch, not once against a layer chosen beforehand.
 *
 * Returning the layer from a ternary chain widens it to a *union* of the five
 * layer types, and `Effect.provide` then only has to satisfy that union — which
 * every branch trivially does. One `Effect.provide` per branch keeps each layer
 * answering for itself.
 *
 * That is a latent hazard removed, not the check that matters here: `cli`'s
 * requirement is only `Command.Environment`, because `withSubcommands` collapses
 * subcommand requirements to `never`. Whether a layer actually provides what its
 * commands resolve is asserted in `commands/layers.ts` — nothing at this call
 * site can see it.
 */
const runCli = (args: ReadonlyArray<string>) => {
  switch (getLayerType(args)) {
    case "full":
      return cli(args).pipe(Effect.provide(AppLayer))
    case "auth":
      return cli(args).pipe(Effect.provide(AuthOnlyLayer))
    case "clone":
      return cli(args).pipe(Effect.provide(CloneLayer))
    case "fetch":
      return cli(args).pipe(Effect.provide(FetchLayer))
    case "minimal":
      return cli(args).pipe(Effect.provide(MinimalLayer))
  }
}

// Suppress verbose Effect logs (e.g. token refresh messages)
Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  return yield* runCli(args)
}).pipe(
  Effect.provide(Layer.mergeAll(NodeTerminal.layer, NodeStdio.layer)),
  Effect.catchCause((cause) => handleError(cause).pipe(Effect.andThen(Effect.failCause(cause)))),
  NodeRuntime.runMain({ disableErrorReporting: true })
)
