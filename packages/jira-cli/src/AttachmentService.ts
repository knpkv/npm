/**
 * Explicit Jira Attachment Upload service.
 *
 * @module
 */
import { normalizeAttachmentMediaType } from "@knpkv/atlassian-common/attachments"
import { JiraApiClient, toEffect } from "@knpkv/jira-api-client"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import type { Attachment } from "./IssueService.js"
import { JiraApiError } from "./JiraCliError.js"

export interface UploadAttachmentInput {
  readonly filePath: string
  readonly filename?: string | undefined
  readonly mediaType?: string | undefined
}

export interface AttachmentServiceShape {
  readonly uploadToIssue: (
    issueIdOrKey: string,
    input: UploadAttachmentInput
  ) => Effect.Effect<Attachment, JiraApiError>
}

export class AttachmentService extends Context.Service<
  AttachmentService,
  AttachmentServiceShape
>()("@knpkv/jira-cli/AttachmentService") {}

const UploadedAttachmentSchema = Schema.Struct({
  id: Schema.String,
  filename: Schema.String,
  content: Schema.String,
  mediaType: Schema.optional(Schema.NullOr(Schema.String)),
  mimeType: Schema.optional(Schema.NullOr(Schema.String)),
  size: Schema.optional(Schema.NullOr(Schema.Number))
})

const decodeUploadedAttachment = (raw: unknown): Effect.Effect<Attachment, JiraApiError> =>
  Schema.decodeUnknownEffect(UploadedAttachmentSchema)(raw).pipe(
    Effect.mapError((cause) => new JiraApiError({ message: "Jira returned an invalid attachment response", cause })),
    Effect.flatMap((record) => {
      if (record.id.length === 0 || record.filename.length === 0 || record.content.length === 0) {
        return Effect.fail(
          new JiraApiError({ message: "Jira returned an attachment without id, filename, or content URL" })
        )
      }
      const mediaType = normalizeAttachmentMediaType(record.mediaType ?? null, record.mimeType ?? null)
      return Effect.succeed({
        id: record.id,
        filename: record.filename,
        url: record.content,
        mediaType,
        mimeType: mediaType ?? "",
        size: record.size ?? 0
      })
    })
  )

const decodeFirstUploadedAttachment = (raw: unknown): Effect.Effect<Attachment, JiraApiError> => {
  if (!Array.isArray(raw)) {
    return Effect.fail(new JiraApiError({ message: "Jira did not return an attachment array" }))
  }
  const first = raw[0]
  if (first === undefined) {
    return Effect.fail(new JiraApiError({ message: "Jira did not return an uploaded attachment" }))
  }
  return decodeUploadedAttachment(first)
}

const make = Effect.gen(function*() {
  const client = yield* JiraApiClient
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const uploadToIssue: AttachmentServiceShape["uploadToIssue"] = (issueIdOrKey, input) =>
    Effect.gen(function*() {
      const bytes = yield* fs.readFile(input.filePath).pipe(
        Effect.mapError((cause) =>
          new JiraApiError({ message: `Failed to read attachment file ${input.filePath}`, cause })
        )
      )
      const filename = input.filename ?? path.basename(input.filePath)
      const buffer = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(buffer).set(bytes)
      const form = new FormData()
      form.append("file", new Blob([buffer], input.mediaType ? { type: input.mediaType } : undefined), filename)

      const result = yield* toEffect(client.v3.client.POST("/rest/api/3/issue/{issueIdOrKey}/attachments", {
        params: { path: { issueIdOrKey } },
        headers: { "X-Atlassian-Token": "no-check" },
        body: [{ name: filename, originalFilename: filename, size: bytes.byteLength }],
        bodySerializer: () => form
      })).pipe(
        Effect.mapError((cause) =>
          new JiraApiError({ message: `Failed to upload attachment to ${issueIdOrKey}`, cause })
        )
      )

      return yield* decodeFirstUploadedAttachment(result)
    })

  return AttachmentService.of({ uploadToIssue })
})

export const layer: Layer.Layer<AttachmentService, never, JiraApiClient | FileSystem.FileSystem | Path.Path> = Layer
  .effect(AttachmentService, make)
