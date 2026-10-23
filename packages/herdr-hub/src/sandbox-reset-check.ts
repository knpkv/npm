#!/usr/bin/env node
/**
 * `sandbox-reset-check <account-id>`: one pool account's reset, read without running it. It reads this
 * host's fleet configuration, signs in as the hub's stored AWS sign-in and needs `AWS_NUKE`, the aws-nuke
 * binary. Nothing in AWS changes: see `sandboxResetCheck`.
 */
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import { HubPaths, loadConfiguration } from "@knpkv/herdr-fleet"
import { Config, Console, Effect, Layer, Option } from "effect"
import { Argument, Command } from "effect/cli"
import { fleetConfigPath } from "./internal/config-path.js"
import { relayVersion } from "./internal/relay-version.js"
import { formatResetInspection, sandboxResetCheck } from "./sandbox-config.js"

const check = Command.make(
  "sandbox-reset-check",
  { accountId: Argument.String("account-id") },
  Effect.fn("SandboxResetCheck.run")(function*({ accountId }) {
    const config = yield* loadConfiguration(yield* fleetConfigPath)
    const nukeBinary = yield* Config.option(Config.String("AWS_NUKE"))
    const inspection = yield* sandboxResetCheck({
      sandboxPool: config.sandboxPool,
      stateDirectory: config.stateDirectory,
      nukeBinary: Option.getOrUndefined(nukeBinary),
      accountId
    }).pipe(Effect.scoped)
    yield* Console.log(formatResetInspection(inspection))
  })
).pipe(Command.withDescription("Read what a reset of one sandbox pool account would do, changing nothing"))

check.pipe(
  Command.run({ version: relayVersion }),
  Effect.provide(Layer.merge(Layer.provideMerge(HubPaths.layer, NodeServices.layer), NodeHttpClient.layerNodeHttp)),
  NodeRuntime.runMain
)
