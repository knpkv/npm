import { Effect, Option, Schema } from "effect"
import { PRCommentLocationJson } from "../../Domain.js"

export type CommentLocationJson = typeof PRCommentLocationJson.Type
export type CommentThreadJson = CommentLocationJson["comments"][number]

export const CommentLocationsFromJson = Schema.fromJsonString(Schema.Array(PRCommentLocationJson))
const CommentLocationsDecoder = CommentLocationsFromJson as unknown as Schema.ConstraintDecoder<
  ReadonlyArray<CommentLocationJson>
>
const decodeCommentLocationsOption = Schema.decodeUnknownOption(CommentLocationsDecoder)

export const decodeCommentLocations = (
  locationsJson: string
): Effect.Effect<ReadonlyArray<CommentLocationJson>> =>
  Effect.succeed(
    Option.getOrElse(decodeCommentLocationsOption(locationsJson), () => [] as ReadonlyArray<CommentLocationJson>)
  )
