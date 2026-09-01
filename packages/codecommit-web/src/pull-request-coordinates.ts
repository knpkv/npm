/** Exact CodeCommit PR coordinates carried through browser review requests. @module */
import { AwsRegion, PullRequestId, RepositoryName } from "@knpkv/codecommit-core/Domain.js"
import { Data, Effect, Encoding, Option, Schema } from "effect"

const coordinateTokenPrefix = "cc1_"
const legacyCoordinateTokenPrefix = "ccpr:"
const coordinatePart = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(180))
const coordinateAccountId = coordinatePart
export const coordinateRouterMaxParamLength = 1024

export const PullRequestCoordinates = Schema.Struct({
  accountId: coordinateAccountId,
  pullRequestId: PullRequestId,
  repositoryName: RepositoryName,
  region: AwsRegion
}).check(
  Schema.makeFilter((coordinates) => {
    const encoded = Encoding.encodeBase64Url(JSON.stringify([
      coordinates.accountId,
      coordinates.pullRequestId,
      coordinates.repositoryName,
      coordinates.region
    ]))
    return encoded.length + coordinateTokenPrefix.length <= coordinateRouterMaxParamLength
      ? undefined
      : "Pull-request coordinate token exceeds the router parameter limit"
  })
)
export type PullRequestCoordinates = typeof PullRequestCoordinates.Type

const coordinateTuple = Schema.Tuple([
  coordinatePart,
  coordinatePart,
  coordinatePart,
  coordinatePart
])

const coordinateObject = Schema.Struct({
  accountId: coordinatePart,
  pullRequestId: coordinatePart,
  repositoryName: coordinatePart,
  region: coordinatePart
})

const toCoordinates = ({ accountId, pullRequestId, region, repositoryName }: {
  readonly accountId: string
  readonly pullRequestId: string
  readonly repositoryName: string
  readonly region: string
}): PullRequestCoordinates => ({
  accountId,
  pullRequestId: PullRequestId.make(pullRequestId),
  repositoryName: RepositoryName.make(repositoryName),
  region: AwsRegion.make(region)
})

export class PullRequestCoordinateDecodeError extends Data.TaggedError(
  "PullRequestCoordinateDecodeError"
)<{ readonly message: string }> {}

/** Encode coordinates into a compact URL-safe token for the existing review API path. */
export const encodePullRequestCoordinates = (coordinates: PullRequestCoordinates): string => {
  const validated = Schema.decodeUnknownSync(PullRequestCoordinates)(coordinates)
  return `${coordinateTokenPrefix}${
    Encoding.encodeBase64Url(JSON.stringify([
      validated.accountId,
      validated.pullRequestId,
      validated.repositoryName,
      validated.region
    ]))
  }`
}

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
        Schema.decodeUnknownEffect(Schema.fromJsonString(coordinateObject))(json).pipe(
          Effect.map((coordinates) => Option.some(toCoordinates(coordinates))),
          Effect.mapError(() => new PullRequestCoordinateDecodeError({ message: "Invalid pull-request coordinates" }))
        )
      )
    )
  }
  if (!value.startsWith(coordinateTokenPrefix)) return Effect.succeed(Option.none())
  const encoded = value.slice(coordinateTokenPrefix.length)
  return Effect.fromResult(Encoding.decodeBase64UrlString(encoded)).pipe(
    Effect.matchEffect({
      // Profile aliases may legitimately begin with the token prefix. A value
      // that is not even base64 is therefore still an ordinary account route.
      onFailure: () => Effect.succeed(Option.none()),
      onSuccess: (json) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(json).pipe(
          Effect.matchEffect({
            // A base64-looking profile alias is still an ordinary account route
            // when its payload is not JSON; a JSON payload must satisfy the
            // coordinate tuple contract below.
            onFailure: () => Effect.succeed(Option.none()),
            onSuccess: (value) =>
              Schema.decodeUnknownEffect(coordinateTuple)(value).pipe(
                Effect.map(([accountId, pullRequestId, repositoryName, region]) =>
                  Option.some(toCoordinates({ accountId, pullRequestId, repositoryName, region }))
                ),
                Effect.mapError(() =>
                  new PullRequestCoordinateDecodeError({ message: "Invalid pull-request coordinates" })
                )
              )
          })
        )
    })
  )
}
