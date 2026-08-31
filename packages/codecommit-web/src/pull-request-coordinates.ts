/** Exact CodeCommit PR coordinates carried through browser review requests. @module */
import { AwsRegion, PullRequestId, RepositoryName } from "@knpkv/codecommit-core/Domain.js"
import { Data, Effect, Encoding, Option, Schema } from "effect"

const coordinateTokenPrefix = "cc1_"
const legacyCoordinateTokenPrefix = "ccpr:"

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

/** Encode coordinates into a compact URL-safe token for the existing review API path. */
export const encodePullRequestCoordinates = (coordinates: PullRequestCoordinates): string =>
  `${coordinateTokenPrefix}${
    Encoding.encodeBase64Url(JSON.stringify([
      coordinates.accountId,
      coordinates.pullRequestId,
      coordinates.repositoryName,
      coordinates.region
    ]))
  }`

/** Decode an exact-coordinate token; ordinary account paths remain legacy routes. */
export const decodePullRequestCoordinates = (
  value: string
): Effect.Effect<Option.Option<PullRequestCoordinates>, PullRequestCoordinateDecodeError> => {
  if (value.startsWith(legacyCoordinateTokenPrefix)) {
    const encoded = value.slice(legacyCoordinateTokenPrefix.length)
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
  if (!value.startsWith(coordinateTokenPrefix)) return Effect.succeed(Option.none())
  const encoded = value.slice(coordinateTokenPrefix.length)
  return Effect.fromResult(Encoding.decodeBase64UrlString(encoded)).pipe(
    Effect.mapError(() => new PullRequestCoordinateDecodeError({ message: "Invalid pull-request coordinate token" })),
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Tuple([
        Schema.String,
        PullRequestId,
        RepositoryName,
        AwsRegion
      ])))(json).pipe(
        Effect.map(([accountId, pullRequestId, repositoryName, region]) => ({
          accountId,
          pullRequestId,
          repositoryName,
          region
        })),
        Effect.map(Option.some),
        Effect.mapError(() => new PullRequestCoordinateDecodeError({ message: "Invalid pull-request coordinates" }))
      )
    )
  )
}
