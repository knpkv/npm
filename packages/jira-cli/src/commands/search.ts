/**
 * Search command for Jira CLI.
 *
 * @module
 */
import { Args, Command, Options } from "@effect/cli"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { buildByVersionJql } from "../internal/jqlBuilder.js"
import { IssueService } from "../IssueService.js"
import { MarkdownWriter } from "../MarkdownWriter.js"

// === Options ===
const jqlArg = Args.text({ name: "jql" }).pipe(
  Args.withDescription("JQL query to search for issues"),
  Args.optional
)

const byVersionOption = Options.text("by-version").pipe(
  Options.withAlias("v"),
  Options.withDescription("Search by fix version (pre-defined query)"),
  Options.optional
)

const projectOption = Options.text("project").pipe(
  Options.withAlias("p"),
  Options.withDescription("Filter by project key"),
  Options.optional
)

const outputDirOption = Options.directory("output-dir").pipe(
  Options.withAlias("o"),
  Options.withDescription("Output directory for markdown files"),
  Options.withDefault("./jira-tickets")
)

const formatOption = Options.choice("format", ["multi", "single"]).pipe(
  Options.withAlias("f"),
  Options.withDescription("Output format: multi (one file per issue) or single (combined file)"),
  Options.withDefault("multi" as const)
)

const maxResultsOption = Options.integer("max-results").pipe(
  Options.withAlias("m"),
  Options.withDescription("Maximum number of results to fetch"),
  Options.withDefault(100)
)

// === Search command ===
export const searchCommand = Command.make(
  "search",
  {
    jql: jqlArg,
    byVersion: byVersionOption,
    project: projectOption,
    outputDir: outputDirOption,
    format: formatOption,
    maxResults: maxResultsOption
  },
  ({ byVersion, format, jql, maxResults, outputDir, project }) =>
    Effect.gen(function*() {
      const issueService = yield* IssueService
      const writer = yield* MarkdownWriter

      // Build JQL query
      let query: string

      if (Option.isSome(byVersion)) {
        const projectKey = Option.isSome(project) ? project.value : undefined
        query = buildByVersionJql(byVersion.value, projectKey)
        yield* Console.log(`Searching by fix version: ${byVersion.value}`)
      } else if (Option.isSome(jql)) {
        query = jql.value
      } else {
        yield* Console.log("Error: Either a JQL query or --by-version must be provided.")
        yield* Console.log("Usage: jira search <jql>")
        yield* Console.log("       jira search --by-version <version>")
        return
      }

      yield* Console.log(`Query: ${query}`)
      yield* Console.log("Fetching issues...")

      const issues = yield* issueService.searchAll(query, { maxResults })

      if (issues.length === 0) {
        yield* Console.log("No issues found.")
        return
      }

      yield* Console.log(`Found ${issues.length} issue(s). Writing to ${outputDir}...`)

      if (format === "single") {
        yield* writer.writeSingle(issues, outputDir, query)
        yield* Console.log(`Exported to ${outputDir}/jira-export.md`)
      } else {
        yield* writer.writeMulti(issues, outputDir)
        yield* Console.log(`Exported ${issues.length} file(s) to ${outputDir}/`)
      }
    })
).pipe(Command.withDescription("Search Jira issues and export to markdown"))
