/**
 * Markdown output service for Jira CLI.
 *
 * @module
 */
import * as FileSystem from "@effect/platform/FileSystem"
import * as Path from "@effect/platform/Path"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { buildCombinedMarkdown, serializeIssue } from "./internal/frontmatter.js"
import type { Issue } from "./IssueService.js"
import { WriteError } from "./JiraCliError.js"

/**
 * MarkdownWriter service interface.
 *
 * @category Services
 */
export interface MarkdownWriterShape {
  /** Write each issue to a separate markdown file */
  readonly writeMulti: (
    issues: ReadonlyArray<Issue>,
    outputDir: string
  ) => Effect.Effect<void, WriteError>
  /** Write all issues to a single markdown file */
  readonly writeSingle: (
    issues: ReadonlyArray<Issue>,
    outputDir: string,
    jql: string
  ) => Effect.Effect<void, WriteError>
}

/**
 * MarkdownWriter service tag.
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import { MarkdownWriter } from "@knpkv/jira-cli/MarkdownWriter"
 *
 * Effect.gen(function* () {
 *   const writer = yield* MarkdownWriter
 *   yield* writer.writeMulti(issues, "./output")
 * })
 * ```
 *
 * @category Services
 */
export class MarkdownWriter extends Context.Tag("@knpkv/jira-cli/MarkdownWriter")<
  MarkdownWriter,
  MarkdownWriterShape
>() {}

const make = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const ensureDir = (dir: string): Effect.Effect<void, WriteError> =>
    fs.makeDirectory(dir, { recursive: true }).pipe(
      Effect.catchAll((cause) =>
        Effect.fail(new WriteError({ path: dir, message: "Failed to create directory", cause }))
      )
    )

  const writeFile = (filePath: string, content: string): Effect.Effect<void, WriteError> =>
    fs.writeFileString(filePath, content).pipe(
      Effect.catchAll((cause) =>
        Effect.fail(new WriteError({ path: filePath, message: "Failed to write file", cause }))
      )
    )

  const writeMulti: MarkdownWriterShape["writeMulti"] = (issues, outputDir) =>
    Effect.gen(function*() {
      yield* ensureDir(outputDir)

      for (const issue of issues) {
        const filename = `${issue.key}.md`
        const filePath = path.join(outputDir, filename)
        const content = serializeIssue(issue)
        yield* writeFile(filePath, content)
      }
    })

  const writeSingle: MarkdownWriterShape["writeSingle"] = (issues, outputDir, jql) =>
    Effect.gen(function*() {
      yield* ensureDir(outputDir)

      const filename = "jira-export.md"
      const filePath = path.join(outputDir, filename)
      const content = buildCombinedMarkdown(issues, jql)
      yield* writeFile(filePath, content)
    })

  return MarkdownWriter.of({ writeMulti, writeSingle })
})

/**
 * Layer for MarkdownWriter service.
 *
 * @category Layers
 */
export const layer: Layer.Layer<MarkdownWriter, never, FileSystem.FileSystem | Path.Path> = Layer.effect(
  MarkdownWriter,
  make
)
