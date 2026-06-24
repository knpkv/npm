/**
 * Root CLI command composition.
 */
import { makeInstallCommand } from "@knpkv/agent-skills"
import * as Console from "effect/Console"
import { Command } from "effect/unstable/cli"
import {
  authCommand,
  cloneCommand,
  commitCommand,
  deleteCommand,
  diffCommand,
  fetchCommand,
  logCommand,
  newCommand,
  pullCommand,
  pushCommand,
  statusCommand
} from "./index.js"

export interface ConfluenceCommandOptions {
  readonly fetch?: typeof fetchCommand
}

const skillsInstall = makeInstallCommand({
  description: "Install the Confluence agent skill",
  name: "install",
  skills: ["confluence"]
})

const skillsCommand = Command.make(
  "skills",
  {},
  () => Console.log("Usage: confluence skills install")
).pipe(
  Command.withDescription("Agent skill commands"),
  Command.withSubcommands([skillsInstall])
)

export const makeConfluenceCommand = (options: ConfluenceCommandOptions = {}) =>
  Command.make("confluence").pipe(
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
      options.fetch ?? fetchCommand,
      newCommand,
      deleteCommand,
      skillsCommand
    ])
  )

export const confluenceCommand = makeConfluenceCommand()
