/**
 * Audited Node filesystem boundary for the credential-bearing cache database.
 *
 * Effect's portable FileSystem currently exposes path-based chmod and string
 * open flags only. This boundary uses O_NOFOLLOW and descriptor-based chmod so
 * a path replacement cannot redirect permission repair to a symlink target.
 *
 * @internal
 */
import * as Effect from "effect/Effect"
import { constants } from "node:fs"
import { lstat, mkdir, open } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { CacheError } from "../CacheError.js"

interface PrivatePathInfo {
  readonly dev: number | bigint
  readonly ino: number | bigint
  readonly isDirectory: () => boolean
  readonly isFile: () => boolean
  readonly isSymbolicLink: () => boolean
}

export interface PrivatePathHandle {
  readonly stat: () => Promise<PrivatePathInfo>
  readonly chmod: (mode: number) => Promise<void>
  readonly close: () => Promise<void>
}

export interface PrivateDatabasePathOperations {
  readonly makeDirectory: (path: string) => Promise<void>
  readonly openDirectory: (path: string) => Promise<PrivatePathHandle>
  readonly openDatabase: (path: string) => Promise<PrivatePathHandle>
  readonly pathInfo: (path: string) => Promise<PrivatePathInfo>
}

const descriptorFlags = constants.O_NOFOLLOW

export const nodePrivateDatabasePathOperations: PrivateDatabasePathOperations = {
  makeDirectory: (path) => mkdir(path, { mode: 0o700, recursive: true }).then(() => undefined),
  openDirectory: (path) => open(path, constants.O_RDONLY | constants.O_DIRECTORY | descriptorFlags),
  openDatabase: (path) => open(path, constants.O_RDWR | constants.O_CREAT | descriptorFlags, 0o600),
  pathInfo: (path) => lstat(path)
}

const sameIdentity = (left: PrivatePathInfo, right: PrivatePathInfo): boolean =>
  left.dev === right.dev && left.ino === right.ino

const fail = (operation: string, cause: unknown) => new CacheError({ operation, cause })

const attempt = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => fail(operation, cause)
  })

const withHandle = <A>(
  operation: string,
  acquire: () => Promise<PrivatePathHandle>,
  use: (handle: PrivatePathHandle) => Effect.Effect<A, CacheError>
) =>
  Effect.acquireUseRelease(
    attempt(operation, acquire),
    use,
    (handle) => attempt(`${operation}-close`, () => handle.close()).pipe(Effect.orDie)
  )

const verifyPathIdentity = (
  operations: PrivateDatabasePathOperations,
  path: string,
  expected: PrivatePathInfo,
  kind: "directory" | "database"
) =>
  attempt("ensure-private-database-path", () => operations.pathInfo(path)).pipe(
    Effect.flatMap((current) =>
      !current.isSymbolicLink() && sameIdentity(current, expected)
        ? Effect.void
        : Effect.fail(
          fail(
            "ensure-private-database-path",
            `Refusing replaced ${kind} path: ${path}`
          )
        )
    )
  )

export const makeEnsurePrivateDatabasePath = (operations: PrivateDatabasePathOperations) =>
  Effect.fn("CacheService.ensurePrivateDatabasePath")(function*(directory: string, database: string) {
    if (resolve(dirname(database)) !== resolve(directory)) {
      return yield* fail(
        "ensure-private-database-path",
        `Database path must be a direct child of its private directory: ${database}`
      )
    }

    yield* attempt("create-private-database-directory", () => operations.makeDirectory(directory))

    yield* withHandle(
      "open-private-database-directory",
      () => operations.openDirectory(directory),
      (directoryHandle) =>
        Effect.gen(function*() {
          const directoryInfo = yield* attempt("inspect-private-database-directory", () => directoryHandle.stat())
          if (!directoryInfo.isDirectory()) {
            return yield* fail(
              "ensure-private-database-path",
              `Cache directory path is not a directory: ${directory}`
            )
          }

          yield* verifyPathIdentity(operations, directory, directoryInfo, "directory")

          yield* withHandle("open-private-database", () =>
            operations.openDatabase(database), (databaseHandle) =>
            Effect.gen(function*() {
              const databaseInfo = yield* attempt("inspect-private-database", () =>
                databaseHandle.stat())
              if (!databaseInfo.isFile()) {
                return yield* fail(
                  "ensure-private-database-path",
                  `Database path is not a regular file: ${database}`
                )
              }

              yield* verifyPathIdentity(operations, database, databaseInfo, "database")
              yield* verifyPathIdentity(operations, directory, directoryInfo, "directory")

              yield* attempt("chmod-private-database-directory", () => directoryHandle.chmod(0o700))
              yield* attempt("chmod-private-database", () => databaseHandle.chmod(0o600))

              yield* verifyPathIdentity(operations, database, databaseInfo, "database")
              yield* verifyPathIdentity(operations, directory, directoryInfo, "directory")
            }))
        })
    )
  })

export const ensurePrivateDatabasePath = makeEnsurePrivateDatabasePath(nodePrivateDatabasePathOperations)
