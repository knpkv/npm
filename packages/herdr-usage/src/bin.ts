#!/usr/bin/env node
/**
 * `herdr-usage [serve] [--port n] [--no-open]` runs the Usage app on its own; the hub runs `herdr-usage --attach`
 * itself. `HERDR_USAGE_LIMITS_COMMAND` overrides the agent-usage command a standalone run reads with
 * (see `./options.ts`).
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { runApp } from "@knpkv/hub-app/node"
import { Effect, Result, Schema } from "effect"
import { createRequire } from "node:module"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { usageApp } from "./app.js"
import { readUsageOptions } from "./options.js"

const require = createRequire(import.meta.url)
const { version } = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }))(require("../package.json"))

const options = readUsageOptions(process.env, { execPath: process.execPath, resolve: require.resolve })

if (Result.isFailure(options)) {
  NodeRuntime.runMain(Effect.fail(options.failure))
} else {
  runApp(usageApp(version, options.success, fileURLToPath(new URL("./client", import.meta.url))), NodeServices.layer)
}
