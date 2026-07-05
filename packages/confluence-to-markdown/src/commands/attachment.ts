/**
 * Confluence page attachment commands.
 *
 * @internal
 */
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import { Argument as Args, Command, Flag as Options } from "effect/unstable/cli"
import type { PageId } from "../Brand.js"
import { ConfluenceClient } from "../ConfluenceClient.js"
import { ApiError, ConfigError, FileSystemError } from "../ConfluenceError.js"
import { insertConfluenceAttachmentReference, renderConfluenceAttachmentReference } from "../internal/attachments.js"

const pageIdArg = Args.string("page-id").pipe(
  Args.withDescription("Confluence page id")
)

const fileArg = Args.string("file").pipe(
  Args.withDescription("Local file to upload")
)

const documentOption = Options.file("document").pipe(
  Options.withDescription("Local Markdown page containing the attachment placeholder"),
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
      Effect.mapError((cause) => new FileSystemError({ operation: "read", path: documentPath, cause }))
    )
  })

const writeDocument = (documentPath: string, content: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.writeFileString(documentPath, content).pipe(
      Effect.mapError((cause) => new FileSystemError({ operation: "write", path: documentPath, cause }))
    )
  })

const fileExists = (filePath: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.exists(filePath).pipe(
      Effect.mapError((cause) => new FileSystemError({ operation: "read", path: filePath, cause }))
    )
  })

const uploadCommand = Command.make(
  "upload",
  {
    pageId: pageIdArg,
    file: fileArg,
    document: documentOption,
    noInsert: noInsertOption,
    dryRun: dryRunOption,
    json: jsonOption
  },
  ({ document, dryRun, file, json, noInsert, pageId }) =>
    Effect.gen(function*() {
      const documentPath = Option.isSome(document) ? document.value : null
      const shouldInsert = !noInsert && documentPath !== null
      const documentInput = shouldInsert
        ? { path: documentPath, content: yield* readDocument(documentPath) }
        : null

      if (documentInput !== null) {
        const matches = countPlaceholderMatches(documentInput.content, file)
        if (matches === 0) {
          return yield* Effect.fail(
            new ConfigError({ message: `No attachment placeholders found for ${file}` })
          )
        }
      }

      if (dryRun) {
        const exists = yield* fileExists(file)
        if (!exists) {
          return yield* Effect.fail(
            new ConfigError({ message: `Attachment file does not exist: ${file}` })
          )
        }
        const result = { dryRun: true, pageId, file, insert: shouldInsert }
        yield* Console.log(json ? JSON.stringify(result) : `Dry run: ${file} can be uploaded to page ${pageId}`)
        return
      }

      const client = yield* ConfluenceClient
      const attachment = yield* client.uploadAttachmentToPage(pageId as PageId, { filePath: file })
      let inserted = false

      if (documentInput !== null) {
        const result = insertConfluenceAttachmentReference(documentInput.content, file, pageId, attachment)
        if (result.replacements === 0) {
          return yield* Effect.fail(
            new ApiError({
              status: 0,
              message: `Uploaded attachment ${attachment.id}, but no local placeholders matched ${file}`,
              endpoint: "attachment insertion",
              pageId
            })
          )
        }
        yield* writeDocument(documentInput.path, result.content)
        inserted = true
      }

      if (json) {
        yield* Console.log(JSON.stringify({ attachment, inserted }))
      } else {
        yield* Console.log(renderConfluenceAttachmentReference(pageId, attachment))
        if (inserted) yield* Console.log(`Inserted into ${documentPath}`)
      }
    })
).pipe(Command.withDescription("Remote write: upload a local file as a Confluence page attachment"))

export const attachmentCommand = Command.make(
  "attachment",
  {},
  () => Console.log("Usage: confluence page attachment upload <page-id> <file>")
).pipe(
  Command.withDescription("Confluence page attachment commands"),
  Command.withSubcommands([uploadCommand])
)

const countPlaceholderMatches = (content: string, placeholderPath: string): number => {
  const escapedPath = placeholderPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return [...content.matchAll(new RegExp(`!?\\[[^\\]]*\\]\\(${escapedPath}\\)`, "g"))].length
}
