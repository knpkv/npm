#!/usr/bin/env node
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import { BrowserOpener } from "@knpkv/browser-pairing/launch"
import { Effect, Layer } from "effect"
import { Command } from "effect/cli"
import { relayPostCommand, relaySelfCommand } from "./internal/relay-cli.js"
import { makeRelayMcpCommand } from "./internal/relay-mcp.js"
import { RelayProbe, relayRootCommand } from "./internal/relay-open.js"
import { readRelayVersion } from "./internal/relay-version.js"

const platform = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp)
const launch = Layer.mergeAll(BrowserOpener.layer, RelayProbe.layer).pipe(Layer.provide(platform))

readRelayVersion().pipe(
  Effect.flatMap((version) =>
    relayRootCommand.pipe(
      Command.withSubcommands([relayPostCommand, relaySelfCommand, makeRelayMcpCommand(version)]),
      Command.run({ version })
    )
  ),
  Effect.provide(Layer.mergeAll(platform, launch)),
  NodeRuntime.runMain
)
