/**
 * Root CLI command composition.
 */
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
      deleteCommand
    ])
  )

export const confluenceCommand = makeConfluenceCommand()
