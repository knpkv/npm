#!/usr/bin/env node
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { Command } from "effect/cli"
import { relayPostCommand } from "./internal/relay-cli.js"

const root = Command.make("relay")

root.pipe(
  Command.withSubcommands([relayPostCommand]),
  Command.run({ version: "0.19.0" }),
  Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
  NodeRuntime.runMain
)
