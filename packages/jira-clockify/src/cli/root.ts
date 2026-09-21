import { makeInstallCommand } from "@knpkv/agent-skills"
import { Effect } from "effect"
import * as Console from "effect/Console"
import * as Stdio from "effect/Stdio"
import { Command } from "effect/unstable/cli"
import * as AuthCommand from "./auth.js"
import { config } from "./config.js"
import { issue } from "./list.js"
import { sync } from "./reconcile.js"
import { launchTuiOrSetup } from "./setup.js"
import { timer } from "./timer.js"
import { watch } from "./watch.js"

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

type RootSubcommand =
  | typeof AuthCommand.auth
  | typeof timer
  | typeof issue
  | typeof sync
  | typeof watch
  | typeof config
  | ReturnType<typeof makeInstallCommand>

export const root: Command.Command<
  "jcf",
  {},
  {},
  Effect.Error<ReturnType<typeof launchTuiOrSetup>> | Command.Error<RootSubcommand>,
  Effect.Services<ReturnType<typeof launchTuiOrSetup>> | Stdio.Stdio | Command.Services<RootSubcommand>
> = Command.make(
  "jcf",
  {},
  () => processArgv.pipe(Effect.flatMap(launchTuiOrSetup))
).pipe(
  Command.withSubcommands([tui, AuthCommand.auth, timer, issue, sync, watch, config, skills])
)
