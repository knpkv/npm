#!/usr/bin/env node
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import { BrowserOpener } from "@knpkv/browser-pairing/launch"
import { Effect, Layer } from "effect"
import { Command } from "effect/cli"
import { relayPostCommand } from "./internal/relay-cli.js"
import { RelayProbe, relayRootCommand } from "./internal/relay-open.js"

const platform = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp)
const launch = Layer.mergeAll(BrowserOpener.layer, RelayProbe.layer).pipe(Layer.provide(platform))

relayRootCommand.pipe(
  Command.withSubcommands([relayPostCommand]),
  Command.run({ version: "0.19.0" }),
  Effect.provide(Layer.mergeAll(platform, launch)),
  NodeRuntime.runMain
)
