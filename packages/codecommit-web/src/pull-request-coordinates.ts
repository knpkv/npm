/** Exact CodeCommit PR coordinates carried through browser review requests. @module */
import { AwsRegion, PullRequestId, RepositoryName } from "@knpkv/codecommit-core/Domain.js"
import { Data, Effect, Option, Schema } from "effect"

const coordinateTokenPrefix = "ccpr:"

export const PullRequestCoordinates = Schema.Struct({
  accountId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  pullRequestId: PullRequestId,
  repositoryName: RepositoryName,
  region: AwsRegion
})
export type PullRequestCoordinates = typeof PullRequestCoordinates.Type

export class PullRequestCoordinateDecodeError extends Data.TaggedError(
  "PullRequestCoordinateDecodeError"
)<{ readonly message: string }> {}

/** Encode coordinates into the account path used by the existing review API. */
export const encodePullRequestCoordinates = (coordinates: PullRequestCoordinates): string =>
  `${coordinateTokenPrefix}${encodeURIComponent(JSON.stringify(coordinates))}`

/** Decode an exact-coordinate token; ordinary account paths remain legacy routes. */
export const decodePullRequestCoordinates = (
  value: string
): Effect.Effect<Option.Option<PullRequestCoordinates>, PullRequestCoordinateDecodeError> => {
  if (!value.startsWith(coordinateTokenPrefix)) return Effect.succeed(Option.none())
  const encoded = value.slice(coordinateTokenPrefix.length)
  return Effect.try({
    try: () => decodeURIComponent(encoded),
    catch: () => new PullRequestCoordinateDecodeError({ message: "Invalid pull-request coordinate token" })
  }).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(PullRequestCoordinates))(json).pipe(
        Effect.map(Option.some),
        Effect.mapError(() => new PullRequestCoordinateDecodeError({ message: "Invalid pull-request coordinates" }))
      )
    )
  )
}
