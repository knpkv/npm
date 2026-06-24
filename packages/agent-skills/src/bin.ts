#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Stdio from "effect/Stdio"
import { Command } from "effect/unstable/cli"
import pkg from "../package.json" with { type: "json" }
import { allSkillNames, makeInstallCommand } from "./index.js"

const installCommand = makeInstallCommand({
  description: "Install all bundled @knpkv skills",
  name: "install",
  skills: allSkillNames
})

const command = Command.make(
  "knpkv-skills",
  {},
  () => Console.log("Usage: knpkv-skills install [--agent codex|claude|all]")
).pipe(
  Command.withDescription("Install @knpkv agent skills for Codex and Claude"),
  Command.withSubcommands([installCommand])
)

const cli = Command.runWith(command, {
  version: pkg.version
})

const program = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  return yield* cli(args)
}).pipe(Effect.provide(NodeServices.layer))

NodeRuntime.runMain(program)
