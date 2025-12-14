#!/usr/bin/env bun
/**
 * CLI entry point for confluence-to-markdown.
 */
import { Command } from "@effect/cli"
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as LogLevel from "effect/LogLevel"
import pkg from "../package.json" with { type: "json" }
import { handleError } from "./commands/errorHandler.js"
import {
  authCommand,
  cloneCommand,
  commitCommand,
  deleteCommand,
  diffCommand,
  logCommand,
  newCommand,
  pullCommand,
  pushCommand,
  statusCommand,
  tuiCommand,
  TuiSettingsLive
} from "./commands/index.js"
import {
  AppLayer,
  AuthOnlyLayer,
  CloneLayer,
  getLayerType,
  MinimalLayer,
  TuiAuthenticatedLayer,
  TuiConfiguredLayer,
  TuiUnauthenticatedLayer
} from "./commands/layers.js"

// === Main command ===
const confluence = Command.make("confluence").pipe(
  Command.withDescription("Sync Confluence pages to local markdown"),
  Command.withSubcommands([
    cloneCommand,
    authCommand,
    pullCommand,
    pushCommand,
    statusCommand,
    commitCommand,
    logCommand,
    diffCommand,
    newCommand,
    deleteCommand,
    tuiCommand
  ])
)

// === Run CLI ===
const cli = Command.run(confluence, {
  name: pkg.name,
  version: pkg.version
})

/**
 * Get the appropriate TUI layer based on auth/config state.
 * Tries configured → authenticated → unauthenticated.
 */
const getTuiLayer = () =>
  Effect.gen(function*() {
    // Try configured first
    const configuredResult = yield* Effect.either(
      Effect.provide(Effect.void, TuiConfiguredLayer)
    )
    if (configuredResult._tag === "Right") {
      return TuiConfiguredLayer
    }

    // Try authenticated
    const authenticatedResult = yield* Effect.either(
      Effect.provide(Effect.void, TuiAuthenticatedLayer)
    )
    if (authenticatedResult._tag === "Right") {
      return TuiAuthenticatedLayer
    }

    // Fall back to unauthenticated
    return TuiUnauthenticatedLayer
  })

const layerType = getLayerType()

// Suppress verbose Effect logs (e.g. token refresh messages)
const SilentLogger = Logger.replace(Logger.defaultLogger, Logger.none)

// Handle TUI specially with mode detection
if (layerType === "tui") {
  Effect.runPromise(getTuiLayer()).then((tuiLayer) => {
    // TuiSettingsLive needs NodeContext for FileSystem/Path
    const settingsLayer = TuiSettingsLive.pipe(Layer.provide(NodeContext.layer))
    const layer = Layer.provideMerge(tuiLayer, settingsLayer)
    const program = Effect.suspend(() => cli(process.argv)).pipe(
      Effect.provide(layer),
      Effect.provide(SilentLogger),
      Logger.withMinimumLogLevel(LogLevel.None)
    )
    Effect.runPromiseExit(program as Effect.Effect<void>).then((exit) => {
      if (exit._tag === "Failure") {
        handleError(exit.cause)
        process.exit(1)
      }
    })
  })
} else {
  const layer = layerType === "full"
    ? AppLayer
    : layerType === "auth"
    ? AuthOnlyLayer
    : layerType === "clone"
    ? CloneLayer
    : MinimalLayer

  const program = Effect.suspend(() => cli(process.argv)).pipe(
    Effect.provide(layer),
    Effect.provide(SilentLogger),
    Logger.withMinimumLogLevel(LogLevel.None)
  )
  Effect.runPromiseExit(program as Effect.Effect<void>).then((exit) => {
    if (exit._tag === "Failure") {
      handleError(exit.cause)
      process.exit(1)
    }
  })
}
