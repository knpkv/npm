import { makeInstallCommand } from "@knpkv/agent-skills"
import { Effect } from "effect"
import * as Console from "effect/Console"
import * as Stdio from "effect/Stdio"
import { Command } from "effect/unstable/cli"
import { auth } from "./auth.js"
import { config } from "./config.js"
import { issue } from "./list.js"
import { sync } from "./reconcile.js"
import { launchTuiOrSetup } from "./setup.js"
import { timer } from "./timer.js"

const processArgv = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  return args
})

const tui = Command.make("tui", {}, () => processArgv.pipe(Effect.flatMap(launchTuiOrSetup)))

const skillsInstall = makeInstallCommand({
  description: "Install the Jira Clockify agent skill",
  name: "install",
  skills: ["jcf"]
})

const skills = Command.make("skills", {}, () => Console.log("Usage: jcf skills install")).pipe(
  Command.withSubcommands([skillsInstall])
)

export const root = Command.make("jcf", {}, () => processArgv.pipe(Effect.flatMap(launchTuiOrSetup))).pipe(
  Command.withSubcommands([tui, auth, timer, issue, sync, config, skills])
)
