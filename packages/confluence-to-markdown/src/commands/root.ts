/**
 * Root CLI command composition.
 */
import { makeInstallCommand } from "@knpkv/agent-skills"
import * as Console from "effect/Console"
import { Command } from "effect/unstable/cli"
import {
  attachmentCommand,
  authCommand,
  cloneCommand,
  commitCommand,
  deleteCommand,
  diffCommand,
  logCommand,
  newCommand,
  pageGetCommand,
  pullCommand,
  pushCommand,
  statusCommand
} from "./index.js"

export interface ConfluenceCommandOptions {
  readonly pageGet?: typeof pageGetCommand
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

const workspaceCommand = Command.make(
  "workspace",
  {},
  () => Console.log("Usage: confluence workspace clone")
).pipe(
  Command.withDescription("Workspace commands"),
  Command.withSubcommands([cloneCommand])
)

const syncCommand = Command.make(
  "sync",
  {},
  () => Console.log("Usage: confluence sync status|diff|pull|push|commit|log")
).pipe(
  Command.withDescription("Sync workflow commands"),
  Command.withSubcommands([
    statusCommand,
    diffCommand,
    pullCommand,
    pushCommand,
    commitCommand,
    logCommand
  ])
)

const pageCommand = (pageGet: typeof pageGetCommand) =>
  Command.make(
    "page",
    {},
    () => Console.log("Usage: confluence page get|new|delete|attachment")
  ).pipe(
    Command.withDescription("Confluence page resource commands"),
    Command.withSubcommands([
      pageGet,
      attachmentCommand,
      newCommand,
      deleteCommand
    ])
  )

export const makeConfluenceCommand = (options: ConfluenceCommandOptions = {}) =>
  Command.make("confluence").pipe(
    Command.withDescription("Sync Confluence pages to local markdown"),
    Command.withSubcommands([
      authCommand,
      workspaceCommand,
      syncCommand,
      pageCommand(options.pageGet ?? pageGetCommand),
      skillsCommand
    ])
  )

export const confluenceCommand = makeConfluenceCommand()
