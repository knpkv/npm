/**
 * Get command for Jira CLI.
 *
 * @module
 */
import { Args, Command, Options } from "@effect/cli"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { IssueService } from "../IssueService.js"
import { MarkdownWriter } from "../MarkdownWriter.js"

const keyArg = Args.text({ name: "key" }).pipe(
  Args.withDescription("Issue key (e.g., PROJ-123)")
)

const outputDirOption = Options.directory("output-dir").pipe(
  Options.withAlias("o"),
  Options.withDescription("Output directory for markdown file"),
  Options.withDefault("./jira-tickets")
)

export const getCommand = Command.make(
  "get",
  {
    key: keyArg,
    outputDir: outputDirOption
  },
  ({ key, outputDir }) =>
    Effect.gen(function*() {
      const issueService = yield* IssueService
      const writer = yield* MarkdownWriter

      yield* Console.log(`Fetching ${key}...`)

      const issue = yield* issueService.getByKey(key)

      yield* Console.log(`Writing to ${outputDir}/${key}.md...`)
      yield* writer.writeMulti([issue], outputDir)

      yield* Console.log(`Done.`)
    })
).pipe(Command.withDescription("Get a single Jira issue by key"))
