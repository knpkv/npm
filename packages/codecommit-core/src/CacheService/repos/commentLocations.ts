import { Effect, Schema } from "effect"
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const optionalString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined

const optionalNumber = (value: unknown): number | undefined => typeof value === "number" ? value : undefined

const requiredString = (value: unknown): string | null => typeof value === "string" ? value : null

const requiredBoolean = (value: unknown): boolean | null => typeof value === "boolean" ? value : null

const parseJson = (json: string): unknown => {
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

const jsonThreadFromUnknown = (value: unknown): CommentThreadJson | null => {
  if (!isRecord(value)) return null
  const root = value["root"]
  const replies = value["replies"]
  if (!isRecord(root) || !Array.isArray(replies)) return null

  const id = requiredString(root["id"])
  const content = requiredString(root["content"])
  const author = requiredString(root["author"])
  const creationDate = requiredString(root["creationDate"])
  const deleted = requiredBoolean(root["deleted"])
  if (id === null || content === null || author === null || creationDate === null || deleted === null) return null

  const decodedReplies: Array<CommentThreadJson> = []
  for (const reply of replies) {
    const decoded = jsonThreadFromUnknown(reply)
    if (decoded === null) return null
    decodedReplies.push(decoded)
  }

  return {
    root: {
      id,
      content,
      author,
      creationDate,
      ...(optionalString(root["inReplyTo"]) !== undefined ? { inReplyTo: optionalString(root["inReplyTo"]) } : {}),
      deleted,
      ...(optionalString(root["filePath"]) !== undefined ? { filePath: optionalString(root["filePath"]) } : {}),
      ...(optionalNumber(root["lineNumber"]) !== undefined ? { lineNumber: optionalNumber(root["lineNumber"]) } : {})
    },
    replies: decodedReplies
  }
}

const jsonLocationFromUnknown = (value: unknown): CommentLocationJson | null => {
  if (!isRecord(value) || !Array.isArray(value["comments"])) return null
  const comments: Array<CommentThreadJson> = []
  for (const comment of value["comments"]) {
    const decoded = jsonThreadFromUnknown(comment)
    if (decoded === null) return null
    comments.push(decoded)
  }
  return {
    ...(optionalString(value["filePath"]) !== undefined ? { filePath: optionalString(value["filePath"]) } : {}),
    ...(optionalString(value["beforeCommitId"]) !== undefined
      ? { beforeCommitId: optionalString(value["beforeCommitId"]) }
      : {}),
    ...(optionalString(value["afterCommitId"]) !== undefined
      ? { afterCommitId: optionalString(value["afterCommitId"]) }
      : {}),
    comments
  }
}

const jsonLocationsFromUnknown = (value: unknown): ReadonlyArray<CommentLocationJson> => {
  if (!Array.isArray(value)) return []
  const locations: Array<CommentLocationJson> = []
  for (const item of value) {
    const decoded = jsonLocationFromUnknown(item)
    if (decoded === null) return []
    locations.push(decoded)
  }
  return locations
}

const threadFromJson = (thread: CommentThreadJson): CommentThread => ({
  root: new PRComment({
    id: decodeCommentId(thread.root.id),
    content: thread.root.content,
    author: thread.root.author,
    creationDate: new Date(thread.root.creationDate),
    ...(thread.root.inReplyTo !== undefined ? { inReplyTo: decodeCommentId(thread.root.inReplyTo) } : {}),
    deleted: thread.root.deleted,
    ...(thread.root.filePath !== undefined ? { filePath: thread.root.filePath } : {}),
    ...(thread.root.lineNumber !== undefined ? { lineNumber: thread.root.lineNumber } : {})
  }),
  replies: thread.replies.map(threadFromJson)
})

const locationFromJson = (location: CommentLocationJson): PRCommentLocation => ({
  ...(location.filePath !== undefined ? { filePath: location.filePath } : {}),
  ...(location.beforeCommitId !== undefined ? { beforeCommitId: location.beforeCommitId } : {}),
  ...(location.afterCommitId !== undefined ? { afterCommitId: location.afterCommitId } : {}),
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
