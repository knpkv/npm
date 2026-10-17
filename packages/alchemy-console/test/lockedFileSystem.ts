import { Effect, FileSystem, PlatformError } from "effect"

/**
 * The real file system, except that reading `locked` fails with PermissionDenied. Mode bits don't
 * stop a privileged user, so tests of unreadable folders use this instead of chmod.
 *
 *   yield* program.pipe(Effect.provideService(FileSystem.FileSystem, yield* lockedFileSystem(dir)))
 */
export const lockedFileSystem = Effect.fnUntraced(function*(locked: string) {
  const real = yield* FileSystem.FileSystem
  return FileSystem.FileSystem.of({
    ...real,
    readDirectory: (path, options) =>
      path === locked ?
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readDirectory",
            pathOrDescriptor: path
          })
        ) :
        real.readDirectory(path, options)
  })
})
