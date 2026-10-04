/**
 * Opening the store file privately.
 *
 * **Mental model**
 *
 * - **Owner-only, or not at all.** The store directory must be `0700` (created so when missing) and
 *   the database and its WAL/SHM files are kept `0600`. A directory others can read is refused
 *   rather than silently tightened: it was set that way by someone.
 * - **No symlinks at the store.** A symlinked directory or database file could point the store
 *   anywhere; it is refused. Ancestors are not checked: a symlinked home is ordinary.
 * - **POSIX only.** Without a mode check that means something, the store fails closed.
 *
 * @module
 */
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { StoreError, UsageStore } from "./Store.js"

const DATABASE_FILE = "usage.db"

const fail = (operation: string, cause: unknown) => Effect.fail(new StoreError({ operation, cause }))

/** `readlink` on something that is not a link fails with EINVAL; nothing else means "not a link". */
const isNotALink = Schema.is(Schema.Struct({ code: Schema.Literal("EINVAL") }))

const refuseSymlink = (fs: FileSystem.FileSystem, path: string) =>
  fs.readLink(path).pipe(
    Effect.matchEffect({
      // Not a link, or not there: both are fine. Any other failure (ELOOP, EIO) fails closed.
      onFailure: (error) =>
        error.reason._tag === "NotFound" || isNotALink(error.cause)
          ? Effect.void
          : fail("secure.readlink", error),
      onSuccess: (target) => fail("secure.symlink", { path, target })
    })
  )

/**
 * Checks the store directory the way the store needs it: no symlink, `0700`, created so when
 * missing. Runs before the store's lock is taken, and again when the store opens.
 */
export const prepareStoreDirectory = Effect.fnUntraced(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (path.sep !== "/") return yield* fail("secure.platform", { sep: path.sep })
  yield* refuseSymlink(fs, directory)
  const exists = yield* fs.exists(directory).pipe(
    Effect.mapError((cause) => new StoreError({ operation: "secure.exists", cause }))
  )
  if (!exists) {
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
      Effect.andThen(fs.chmod(directory, 0o700)),
      Effect.mapError((cause) => new StoreError({ operation: "secure.create-directory", cause }))
    )
  }
  const info = yield* fs.stat(directory).pipe(
    Effect.mapError((cause) => new StoreError({ operation: "secure.stat", cause }))
  )
  if (info.type !== "Directory") return yield* fail("secure.directory-type", { directory, type: info.type })
  if ((info.mode & 0o777) !== 0o700) {
    return yield* fail("secure.directory-mode", { directory, mode: (info.mode & 0o777).toString(8) })
  }
  const filename = path.join(directory, DATABASE_FILE)
  const files = [filename, `${filename}-wal`, `${filename}-shm`]
  yield* Effect.forEach(files, (file) => refuseSymlink(fs, file), { discard: true })
  return { filename, files }
})

const restrictFiles = Effect.fnUntraced(function*(files: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  for (const file of files) {
    yield* refuseSymlink(fs, file)
    const exists = yield* fs.exists(file).pipe(
      Effect.mapError((cause) => new StoreError({ operation: "secure.exists", cause }))
    )
    if (exists) {
      yield* fs.chmod(file, 0o600).pipe(
        Effect.mapError((cause) => new StoreError({ operation: "secure.chmod", cause }))
      )
    }
  }
})

/** The store, opened privately in `directory` (`usage.db`), migrated and ready. */
export const databaseLayer = (
  directory: string
): Layer.Layer<UsageStore, StoreError, FileSystem.FileSystem | Path.Path> =>
  Layer.unwrap(Effect.gen(function*() {
    const { filename, files } = yield* prepareStoreDirectory(directory)
    return UsageStore.layer.pipe(
      Layer.provide(SqliteClient.layer({ filename })),
      Layer.tap(() => restrictFiles(files))
    )
  }))
