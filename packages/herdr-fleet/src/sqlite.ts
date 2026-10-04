/**
 * Private on-disk SQLite databases for Herdr stores.
 *
 * **Mental model**
 *
 * - **Refuse, never repair.** A state directory or database file that other users
 *   could write is refused, and left exactly as found. Repairing it would hide that
 *   someone could already have changed it.
 * - **Owner-only once accepted.** The state directory ends `0700` and the database
 *   files `0600`; an existing directory is checked before it is restricted, so a
 *   writable one is refused rather than quietly fixed.
 * - **Only the last path component is checked for a symlink.** Symlinked ancestors
 *   (macOS `/var`, a Nix-managed home) are normal and allowed; a database or state
 *   directory that is itself a link is refused.
 * - **Two layers.** {@link preparePrivateDatabasePath} and
 *   {@link securePrivateDatabaseFiles} only touch the file system, so any SQLite
 *   client can use them; {@link openPrivateSqlite} adds the `node:sqlite` connection.
 *
 * @example
 * ```ts
 * const opened = yield* openPrivateSqlite(path, {
 *   initialize: (database) => database.exec("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY)")
 * })
 * // after each write, WAL may have created -wal/-shm:
 * yield* opened.secureFiles
 * ```
 *
 * @module
 */
import { Effect, FileSystem, Path, Schema } from "effect"
import { DatabaseSync } from "node:sqlite"

/** One step of opening or securing a private database failed; `operation` names the step. */
export class PrivateDatabaseError extends Schema.TaggedError<PrivateDatabaseError>()(
  "PrivateDatabaseError",
  {
    operation: Schema.String,
    cause: Schema.Defect()
  }
) {}

const failWith = (operation: string) => (cause: unknown) => new PrivateDatabaseError({ operation, cause })

const groupOrOtherWritable = (paths: Path.Path, mode: number): boolean => paths.sep === "/" && (mode & 0o022) !== 0

const databaseFiles = (path: string): ReadonlyArray<string> => [path, `${path}-wal`, `${path}-shm`]

// Refuses `path` when it is itself a symlink — including a dangling one — or when
// its real path is not its real parent joined with its name. A component that does
// not exist yet is checked through its parent.
const verifyPathIdentity = (
  path: string,
  fileSystem: FileSystem.FileSystem,
  paths: Path.Path,
  operation: string
): Effect.Effect<void, PrivateDatabaseError> =>
  fileSystem.readLink(path).pipe(
    Effect.matchEffect({
      onFailure: (cause) =>
        cause.reason._tag === "NotFound" || cause.reason._tag === "Unknown"
          ? Effect.void
          : Effect.fail(new PrivateDatabaseError({ cause, operation: `${operation}.readlink` })),
      onSuccess: (target) => Effect.fail(new PrivateDatabaseError({ cause: { path, target }, operation }))
    }),
    Effect.andThen(fileSystem.exists(path).pipe(Effect.mapError(failWith(`${operation}.exists`)))),
    Effect.flatMap((exists) => {
      const parent = paths.dirname(path)
      if (!exists) {
        return parent === path ? Effect.void : verifyPathIdentity(parent, fileSystem, paths, operation)
      }
      return Effect.all({
        realPath: fileSystem.realPath(path).pipe(Effect.mapError(failWith(`${operation}.realpath`))),
        realParentPath: fileSystem.realPath(parent).pipe(Effect.mapError(failWith(`${operation}.parent-realpath`)))
      }).pipe(Effect.flatMap(({ realParentPath, realPath }) => {
        const expectedPath = paths.join(realParentPath, paths.basename(path))
        return realPath === expectedPath
          ? Effect.void
          : Effect.fail(new PrivateDatabaseError({ cause: { expectedPath, path, realPath }, operation }))
      }))
    })
  )

/**
 * Refuse `path` if it is itself a symlink or does not resolve to its real parent
 * joined with its name; a missing component is checked through its parent.
 * Failures carry `operation` (sub-steps append `.readlink`, `.exists`, …).
 */
export const verifyPrivatePathIdentity = Effect.fn("PrivateDatabase.verifyPathIdentity")(function*(
  path: string,
  operation: string
) {
  const fileSystem = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  yield* verifyPathIdentity(path, fileSystem, paths, operation)
})

/**
 * Make `path`'s directory and any existing database files safe to open, or refuse.
 *
 * Refuses a directory or file that is a symlink, the wrong type, or group/other
 * writable, without changing it. Otherwise restricts the directory (created if
 * missing) to `0700` and existing db/-wal/-shm files to `0600`.
 */
export const preparePrivateDatabasePath = Effect.fn("PrivateDatabase.prepare")(function*(path: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  const directory = paths.dirname(path)
  yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
    Effect.mapError(failWith("open.directory"))
  )
  const directoryInfo = yield* fileSystem.stat(directory).pipe(Effect.mapError(failWith("open.directory.stat")))
  if (directoryInfo.type !== "Directory" || groupOrOtherWritable(paths, directoryInfo.mode)) {
    return yield* new PrivateDatabaseError({
      cause: { directory, mode: directoryInfo.mode, type: directoryInfo.type },
      operation: "open.directory.unsafe"
    })
  }
  yield* verifyPathIdentity(directory, fileSystem, paths, "open.directory.path-identity")
  yield* fileSystem.chmod(directory, 0o700).pipe(Effect.mapError(failWith("open.secureDirectory")))
  yield* Effect.forEach(
    databaseFiles(path),
    (file) =>
      verifyPathIdentity(file, fileSystem, paths, "open.path-identity").pipe(
        Effect.andThen(fileSystem.exists(file).pipe(Effect.mapError(failWith("open.file.exists")))),
        Effect.flatMap((exists) => {
          if (!exists) return Effect.void
          return fileSystem.stat(file).pipe(
            Effect.mapError(failWith("open.file.stat")),
            Effect.flatMap((info) =>
              info.type !== "File" || groupOrOtherWritable(paths, info.mode)
                ? Effect.fail(
                  new PrivateDatabaseError({
                    cause: { file, mode: info.mode, type: info.type },
                    operation: "open.file.unsafe"
                  })
                )
                : fileSystem.chmod(file, 0o600).pipe(Effect.mapError(failWith("open.file.secure")))
            )
          )
        })
      ),
    { discard: true }
  )
})

/**
 * Set the database file and its `-wal`/`-shm` siblings, whichever exist, to `0600`.
 *
 * SQLite creates the siblings lazily, so call this after writes as well as after
 * opening. A sibling that has become a symlink is refused rather than followed.
 */
export const securePrivateDatabaseFiles = Effect.fn("PrivateDatabase.secureFiles")(function*(path: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  yield* Effect.forEach(
    databaseFiles(path),
    (file) =>
      verifyPathIdentity(file, fileSystem, paths, "secure.path-identity").pipe(
        Effect.andThen(fileSystem.exists(file).pipe(Effect.mapError(failWith("secure.exists")))),
        Effect.flatMap((exists) =>
          exists ? fileSystem.chmod(file, 0o600).pipe(Effect.mapError(failWith("secure.chmod"))) : Effect.void
        )
      ),
    { discard: true }
  )
})

/** An open `node:sqlite` connection to a private database. */
export interface PrivateSqlite {
  readonly database: DatabaseSync
  /** {@link securePrivateDatabaseFiles} for this database; run after writes. */
  readonly secureFiles: Effect.Effect<void, PrivateDatabaseError>
}

export interface OpenPrivateSqliteOptions {
  /**
   * Creates or migrates the schema; a throw closes the connection. Runs before WAL
   * is enabled, so a legacy rollback-journal database migrates in its own mode first
   * (Work's legacy authority-table migration fails with "database is locked" otherwise).
   */
  readonly initialize: (database: DatabaseSync) => void
  /** Wait up to this long for another connection's lock instead of failing at once. */
  readonly busyTimeoutMillis?: number
}

/**
 * Prepare `path` (see {@link preparePrivateDatabasePath}), open it in WAL mode,
 * initialize the schema and secure the files. The caller owns the returned
 * connection and must close it.
 */
export const openPrivateSqlite = Effect.fn("PrivateDatabase.openSqlite")(function*(
  path: string,
  options: OpenPrivateSqliteOptions
) {
  const fileSystem = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  yield* preparePrivateDatabasePath(path)
  const database = yield* Effect.try({
    try: () => {
      const database = new DatabaseSync(path)
      try {
        if (options.busyTimeoutMillis !== undefined) {
          database.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMillis}`)
        }
        options.initialize(database)
        database.exec("PRAGMA journal_mode = WAL")
        return database
      } catch (error) {
        database.close()
        throw error
      }
    },
    catch: failWith("open.database")
  })
  const secureFiles = securePrivateDatabaseFiles(path).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, paths)
  )
  yield* secureFiles.pipe(Effect.onError(() => Effect.sync(() => database.close())))
  return { database, secureFiles } satisfies PrivateSqlite
})
