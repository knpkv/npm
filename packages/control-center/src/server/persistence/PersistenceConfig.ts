import { Effect, Schema } from "effect"
import { PersistenceConfigError } from "./errors.js"

const LOCAL_DATABASE_URL_PATTERN = /^file:(?:\/(?!\/)|\/\/\/(?!\/)|[A-Za-z]:[\\/])[^?#]+$/u
const ABSOLUTE_PATH_PATTERN = /^(?:\/|[A-Za-z]:[\\/])/u
const ENCODED_CONTROL_CHARACTER_PATTERN = /%(?:[01][0-9a-f]|7f|8[0-9a-f]|9[0-9a-f])/iu

const hasNoControlCharacters = (value: string): boolean =>
  Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0)
    return (
      codePoint !== undefined &&
      !((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f))
    )
  })

const SafeLocalString = Schema.String.check(
  Schema.makeFilter(hasNoControlCharacters, {
    expected: "a local value without control characters"
  }),
  Schema.makeFilter((value) => !ENCODED_CONTROL_CHARACTER_PATTERN.test(value), {
    expected: "a local value without encoded control characters"
  })
)

/** Local libSQL database URL accepted by the Control Center persistence layer. */
export const LocalDatabaseUrl = SafeLocalString.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096),
  Schema.isPattern(LOCAL_DATABASE_URL_PATTERN, {
    expected: "a local file: database URL without an authority"
  })
).pipe(Schema.brand("LocalDatabaseUrl"))

/** Decoded local libSQL database URL. */
export type LocalDatabaseUrl = typeof LocalDatabaseUrl.Type

/** Absolute owner-controlled root for content-addressed blob bytes. */
export const BlobRoot = SafeLocalString.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(4_096),
  Schema.isPattern(ABSOLUTE_PATH_PATTERN, { expected: "an absolute filesystem path" })
).pipe(Schema.brand("BlobRoot"))

/** Decoded owner-controlled blob root. */
export type BlobRoot = typeof BlobRoot.Type

/** Secret-free configuration shared by the database and blob persistence layers. */
export const PersistenceConfig = Schema.Struct({
  blobRoot: BlobRoot,
  busyTimeoutMilliseconds: Schema.Literal(5_000),
  databaseUrl: LocalDatabaseUrl,
  maxConnections: Schema.Literal(1)
}).annotate({ identifier: "PersistenceConfig" })

/** Decoded Control Center persistence configuration. */
export type PersistenceConfig = typeof PersistenceConfig.Type

/** Decode untrusted persistence configuration without exposing rejected values. */
export const decodePersistenceConfig = Effect.fn("decodePersistenceConfig")(function*(
  input: unknown
): Effect.fn.Return<PersistenceConfig, PersistenceConfigError> {
  return yield* Schema.decodeUnknownEffect(PersistenceConfig)(input).pipe(
    Effect.mapError(
      () =>
        new PersistenceConfigError({
          message:
            "Persistence configuration requires a local database URL, absolute blob root, and bounded concurrency"
        })
    )
  )
})
