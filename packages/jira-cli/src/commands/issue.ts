/**
 * `jira issue` command namespace.
 *
 * @internal
 */
import { Command } from "effect/unstable/cli"
import { getCommand } from "./get.js"
import { searchCommand } from "./search.js"

export const issueCommand = Command.make("issue").pipe(
  Command.withDescription("Read-only Jira issue commands"),
  Command.withSubcommands([getCommand, searchCommand])
)
