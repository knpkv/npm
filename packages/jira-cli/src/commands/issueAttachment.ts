/**
 * `jira issue attachment` resource commands.
 *
 * @internal
 */
import { renderAttachmentMarkdown } from "@knpkv/atlassian-common/attachments"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import { Argument as Args, Command, Flag as Options } from "effect/unstable/cli"
import { AttachmentService } from "../AttachmentService.js"
import { insertJiraAttachmentReference } from "../internal/attachmentInsertion.js"
import { JiraApiError, WriteError } from "../JiraCliError.js"

const issueArg = Args.string("issue").pipe(
  Args.withDescription("Issue key or id, for example PROJ-123")
)

const fileArg = Args.string("file").pipe(
  Args.withDescription("Local file to upload")
)

const documentOption = Options.file("document").pipe(
  Options.withDescription("Local Jira Markdown document containing the attachment placeholder"),
  Options.optional
)

const noInsertOption = Options.boolean("no-insert").pipe(
  Options.withDescription("Only upload and print the Attachment Reference")
)

const dryRunOption = Options.boolean("dry-run").pipe(
  Options.withAlias("n"),
  Options.withDescription("Validate local insertion input without uploading")
)

const jsonOption = Options.boolean("json").pipe(
  Options.withDescription("Write exactly one JSON value to stdout")
)

const readDocument = (documentPath: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(documentPath).pipe(
      Effect.mapError((cause) =>
        new WriteError({ path: documentPath, message: "Failed to read Jira Markdown document", cause })
      )
    )
  })

const writeDocument = (documentPath: string, content: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.writeFileString(documentPath, content).pipe(
      Effect.mapError((cause) =>
        new WriteError({ path: documentPath, message: "Failed to write Jira Markdown document", cause })
      )
    )
  })

const fileExists = (filePath: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.exists(filePath).pipe(
      Effect.mapError((cause) => new WriteError({ path: filePath, message: "Failed to check attachment file", cause }))
    )
  })

const uploadCommand = Command.make(
  "upload",
  {
    issue: issueArg,
    file: fileArg,
    document: documentOption,
    noInsert: noInsertOption,
    dryRun: dryRunOption,
    json: jsonOption
  },
  ({ document, dryRun, file, issue, json, noInsert }) =>
    Effect.gen(function*() {
      const documentPath = Option.isSome(document) ? document.value : null
      const shouldInsert = !noInsert && documentPath !== null
      const documentInput = shouldInsert
        ? { path: documentPath, content: yield* readDocument(documentPath) }
        : null

      if (documentInput !== null) {
        const matches = countPlaceholderMatches(documentInput.content, file)
        if (matches !== 1) {
          return yield* Effect.fail(
            new JiraApiError({ message: `Expected exactly one attachment placeholder for ${file}, found ${matches}` })
          )
        }
      }

      if (dryRun) {
        const exists = yield* fileExists(file)
        if (!exists) {
          return yield* Effect.fail(new JiraApiError({ message: `Attachment file does not exist: ${file}` }))
        }
        const result = { dryRun: true, issue, file, insert: shouldInsert }
        yield* Console.log(json ? JSON.stringify(result) : `Dry run: ${file} can be uploaded to ${issue}`)
        return
      }

      const service = yield* AttachmentService
      const attachment = yield* service.uploadToIssue(issue, { filePath: file })
      let inserted = false

      if (documentInput !== null) {
        const result = insertJiraAttachmentReference(documentInput.content, file, attachment)
        if (result.replacements !== 1) {
          return yield* Effect.fail(
            new JiraApiError({
              message:
                `Uploaded attachment ${attachment.id}, but expected exactly one local placeholder for ${file}; found ${result.replacements}`
            })
          )
        }
        yield* writeDocument(documentInput.path, result.content)
        inserted = true
      }

      if (json) {
        yield* Console.log(JSON.stringify({ attachment, inserted }))
      } else {
        yield* Console.log(renderAttachmentMarkdown(attachment))
        if (inserted) yield* Console.log(`Inserted into ${documentPath}`)
      }
    })
).pipe(Command.withDescription("Remote write: upload a local file as a Jira issue attachment"))

export const attachmentCommand = Command.make(
  "attachment",
  {},
  () => Console.log("Usage: jira issue attachment upload <issue> <file>")
).pipe(
  Command.withDescription("Jira issue attachment commands"),
  Command.withSubcommands([uploadCommand])
)

const countPlaceholderMatches = (content: string, placeholderPath: string): number => {
  const escapedPath = placeholderPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return [...content.matchAll(new RegExp(`!?\\[[^\\]]*\\]\\(${escapedPath}\\)`, "g"))].length
}
