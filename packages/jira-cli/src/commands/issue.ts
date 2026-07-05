/**
 * `jira issue` command namespace.
 *
 * @internal
 */
import { Command } from "effect/unstable/cli"
import { getCommand } from "./get.js"
import { attachmentCommand } from "./issueAttachment.js"
import { searchCommand } from "./search.js"

export const issueCommand = Command.make("issue").pipe(
  Command.withDescription("Jira issue resource commands"),
  Command.withSubcommands([attachmentCommand, getCommand, searchCommand])
)
