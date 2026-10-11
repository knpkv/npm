/** Durable private Code locators behind random browser references; no provider credentials. @module */
import { CodeReference } from "@knpkv/codecommit-web/host"
import { CodeCoordinates, CodeHostReadError, type CodeReferenceStore } from "@knpkv/codecommit-web/host/server"
import { openPrivateSqlite } from "@knpkv/herdr-fleet/sqlite"
import { Crypto, Effect, Schema } from "effect"

const storedCoordinates = Schema.Struct({ coordinates: Schema.String })
const storedReference = Schema.Struct({ reference: CodeReference })
const coordinatesJson = Schema.fromJsonString(CodeCoordinates)
const encodeCoordinates = Schema.encodeSync(coordinatesJson)
const unavailable = () => new CodeHostReadError({ reason: "unavailable" })
const capacity = 10_000

/**
 * The caller scope owns the SQLite handle. Private coordinates retain a random ID on restart.
 * The map keeps 10,000 references; listing touches an access sequence and minting evicts the
 * least recently seen reference, which then resolves to 404. The sequence is not a timestamp.
 */
export const makeCodeReferences = Effect.fn("CodeReferenceStore.make")(function*(path: string) {
  const opened = yield* Effect.acquireRelease(
    openPrivateSqlite(path, {
      busyTimeoutMillis: 500,
      initialize: (database) => {
        database.exec(`
        CREATE TABLE IF NOT EXISTS code_references (
          reference TEXT PRIMARY KEY NOT NULL,
          coordinates TEXT UNIQUE NOT NULL,
          last_seen INTEGER NOT NULL DEFAULT 0
        )
        `)
        const columns = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))(
          database.prepare("PRAGMA table_info(code_references)").all()
        )
        if (!columns.some((column) => column.name === "last_seen")) {
          database.exec("ALTER TABLE code_references ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0")
        }
        database.exec("CREATE INDEX IF NOT EXISTS code_references_seen ON code_references(last_seen)")
      }
    }).pipe(Effect.mapError(unavailable)),
    (resource) => Effect.sync(() => resource.database.close())
  )
  const cryptoService = yield* Crypto.Crypto
  const database = opened.database
  const reference = Effect.fn("CodeReferenceStore.reference")(function*(coordinates: CodeCoordinates) {
    const key = encodeCoordinates(coordinates)
    const find = () => database.prepare("SELECT reference FROM code_references WHERE coordinates = ?").get(key)
    const existing = yield* Effect.try({ try: find, catch: unavailable })
    const generated = existing === undefined ?
      yield* cryptoService.randomUUIDv4.pipe(Effect.mapError(unavailable)) :
      (yield* Schema.decodeUnknownEffect(storedReference)(existing).pipe(Effect.mapError(unavailable))).reference
    yield* Effect.try({
      try: () => {
        database.exec("BEGIN IMMEDIATE")
        try {
          database.prepare("INSERT OR IGNORE INTO code_references (reference, coordinates) VALUES (?, ?)").run(
            generated,
            key
          )
          database.prepare(`UPDATE code_references SET last_seen =
            COALESCE((SELECT MAX(last_seen) FROM code_references), 0) + 1 WHERE coordinates = ?`).run(key)
          database.prepare(`DELETE FROM code_references WHERE rowid IN (
            SELECT rowid FROM code_references ORDER BY last_seen, rowid LIMIT MAX(0, (SELECT count(*) FROM code_references) - ?)
          )`).run(capacity)
          database.exec("COMMIT")
        } catch (cause) {
          database.exec("ROLLBACK")
          throw cause
        }
      },
      catch: unavailable
    })
    yield* opened.secureFiles.pipe(Effect.mapError(unavailable))
    return (yield* Effect.try({ try: find, catch: unavailable }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(storedReference)),
      Effect.mapError(unavailable)
    )).reference
  })
  const resolve = Effect.fn("CodeReferenceStore.resolve")(function*(ref: CodeReference) {
    const found = yield* Effect.try({
      try: () => database.prepare("SELECT coordinates FROM code_references WHERE reference = ?").get(ref),
      catch: unavailable
    })
    if (found === undefined) return null
    const stored = yield* Schema.decodeUnknownEffect(storedCoordinates)(found).pipe(Effect.mapError(unavailable))
    return yield* Schema.decodeUnknownEffect(coordinatesJson)(stored.coordinates).pipe(Effect.mapError(unavailable))
  })
  return { reference, resolve } satisfies CodeReferenceStore
})
