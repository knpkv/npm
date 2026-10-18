import { ByteSize, Deferred, Effect, FileSystem, Option, PlatformError, Ref } from "effect"

/** The fields this helper reads off a synchronous stat. Callers pass `node:fs` from a test file. */
export interface ClockedStat {
  readonly isDirectory: () => boolean
  readonly dev: number
  readonly ino: number
  readonly mode: number
  readonly nlink: number
  readonly uid: number
  readonly gid: number
  readonly size: number
}

/**
 * Synchronous directory reads. `TestClock.adjust` jumps to the end of its duration whenever the
 * fiber suspends on an async read, so the budget check would never see the time between directories.
 * The `node:fs` calls stay in the `*.test.ts` files, which are the files allowed to import it.
 */
export interface ClockedIo {
  readonly readDirectory: (directory: string) => Array<string>
  readonly realPath: (path: string) => string
  readonly exists: (path: string) => boolean
  readonly stat: (path: string) => ClockedStat
}

const infoFor = (stat: ClockedStat): FileSystem.File.Info => ({
  type: stat.isDirectory() ? "Directory" : "File",
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: stat.dev,
  ino: Option.some(stat.ino),
  mode: stat.mode,
  nlink: Option.some(stat.nlink),
  uid: Option.some(stat.uid),
  gid: Option.some(stat.gid),
  rdev: Option.none(),
  size: ByteSize.bytes(stat.size),
  blksize: Option.none(),
  blocks: Option.none()
})

const missing = (method: "realPath" | "stat", path: string) =>
  PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method, pathOrDescriptor: path })

/**
 * Directory reads and stats sleep on the test clock, then use `io`.
 * `started` completes when the first delayed read or stat is about to sleep. Await it, then adjust.
 * Reads after `delayReads`, and stats after `delayStats`, do not sleep.
 */
export const clockedFileSystem = Effect.fnUntraced(function*(
  delayReads: number,
  io: ClockedIo,
  delayStats = 0
) {
  const real = yield* FileSystem.FileSystem
  const started = yield* Deferred.make<void>()
  const reads = yield* Ref.make(0)
  const stats = yield* Ref.make(0)
  const fs = FileSystem.FileSystem.of({
    ...real,
    readDirectory: (directory) =>
      Effect.gen(function*() {
        const count = yield* Ref.updateAndGet(reads, (value) => value + 1)
        if (count === 1 && delayReads > 0) yield* Deferred.succeed(started, undefined)
        if (count <= delayReads) yield* Effect.sleep("1 second")
        return io.readDirectory(directory)
      }),
    realPath: (path) => Effect.try({ try: () => io.realPath(path), catch: () => missing("realPath", path) }),
    exists: (path) => Effect.sync(() => io.exists(path)),
    stat: (path) =>
      Effect.gen(function*() {
        const count = yield* Ref.updateAndGet(stats, (value) => value + 1)
        if (count <= delayStats) {
          if (delayReads === 0 && count === 1) yield* Deferred.succeed(started, undefined)
          yield* Effect.sleep("1 second")
        }
        return yield* Effect.try({ try: () => infoFor(io.stat(path)), catch: () => missing("stat", path) })
      })
  })
  return { fs, started }
})
