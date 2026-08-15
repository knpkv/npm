import { Effect, Option, Schema } from "effect"
import {
  CommentId,
  type CommentThread,
  PRComment,
  type PRCommentLocation,
  PRCommentLocationJson
} from "../../Domain.js"

export type CommentLocationJson = typeof PRCommentLocationJson.Type
export type CommentThreadJson = CommentLocationJson["comments"][number]

const decodeCommentId = Schema.decodeUnknownSync(CommentId)
const decodeCommentLocationJsonArray = Schema.decodeUnknownOption(Schema.Array(PRCommentLocationJson))
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))

const parseJson = (json: string): Schema.Json | undefined => {
  try {
    return decodeJson(json)
  } catch {
    return undefined
  }
}

const jsonLocationsFromUnknown = <UnparsedInput>(value: UnparsedInput): ReadonlyArray<CommentLocationJson> => {
  // Cached comment groups are one coherent snapshot. Reject the whole payload
  // to an empty snapshot when any persisted field violates the wire schema.
  return Option.getOrElse(decodeCommentLocationJsonArray(value), () => [])
}

const threadFromJson = (thread: CommentThreadJson): CommentThread => ({
  root: new PRComment({
    id: decodeCommentId(thread.root.id),
    content: thread.root.content,
    author: thread.root.author,
    creationDate: new Date(thread.root.creationDate),
    ...((thread.root.inReplyTo !== undefined) && { inReplyTo: decodeCommentId(thread.root.inReplyTo) }),
    deleted: thread.root.deleted,
    ...((thread.root.filePath !== undefined) && { filePath: thread.root.filePath }),
    ...((thread.root.lineNumber !== undefined) && { lineNumber: thread.root.lineNumber })
  }),
  replies: thread.replies.map(threadFromJson)
})

const locationFromJson = (location: CommentLocationJson): PRCommentLocation => ({
  ...((location.filePath !== undefined) && { filePath: location.filePath }),
  ...((location.beforeCommitId !== undefined) && { beforeCommitId: location.beforeCommitId }),
  ...((location.afterCommitId !== undefined) && { afterCommitId: location.afterCommitId }),
  ...((location.relativeFileVersion !== undefined) && { relativeFileVersion: location.relativeFileVersion }),
  comments: location.comments.map(threadFromJson)
})

export const decodeCommentLocations = (
  locationsJson: string
): Effect.Effect<ReadonlyArray<PRCommentLocation>> =>
  decodeCommentLocationJson(locationsJson).pipe(
    Effect.map((locations) => locations.map(locationFromJson))
  )

export const decodeCommentLocationJson = (
  locationsJson: string
): Effect.Effect<ReadonlyArray<CommentLocationJson>> =>
  Effect.sync(() => jsonLocationsFromUnknown(parseJson(locationsJson)))
