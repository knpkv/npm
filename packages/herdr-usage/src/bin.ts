#!/usr/bin/env node
/**
 * `herdr-usage [serve] [--port n] [--no-open]` runs the Usage app on its own; `herdr-usage --socket <path>` attaches
 * it to the hub. `HERDR_USAGE_LIMITS_COMMAND` (a JSON array) overrides the agent-usage command a standalone run
 * reads this machine with; the default runs the installed `@knpkv/agent-usage` with this node, so it needs no PATH
 * entry or shell shim (Windows has `.cmd` shims, which spawn without a shell cannot run).
 */
import { NodeServices } from "@effect/platform-node"
import { runApp } from "@knpkv/hub-app/node"
import { Option, Schema } from "effect"
import { createRequire } from "node:module"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { usageApp } from "./app.js"

const require = createRequire(import.meta.url)
const { version } = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }))(require("../package.json"))

const limitsCommand = Option.getOrElse(
  Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))(
    process.env.HERDR_USAGE_LIMITS_COMMAND
  ),
  () => [process.execPath, require.resolve("@knpkv/agent-usage/main.js"), "limits"]
)

runApp(
  usageApp(version, { limitsCommand }, fileURLToPath(new URL("./client", import.meta.url))),
  NodeServices.layer
)
