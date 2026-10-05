/** @effect-diagnostics strictEffectProvide:skip-file */
/**
 * What makes a byte budget safe around a child process: when the budget is
 * exceeded, or the caller's deadline fires, the collection fails, the scope
 * closes, and the child is killed rather than left writing into a closed pipe.
 */
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, Schedule } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { collectBounded } from "../src/index.js"

// Writes its pid, then writes 4 KiB to stdout every millisecond, forever.
const endlessWriter = (pidFile: string) =>
  ChildProcess.make("node", [
    "-e",
    `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
    `const b = Buffer.alloc(4096, 120); setInterval(() => process.stdout.write(b), 1)`
  ])

const isAlive = (pid: string) =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const code = yield* spawner.exitCode(ChildProcess.make("kill", ["-0", pid], { stderr: "ignore" }))
    return code === 0
  })

const waitForPid = (pidFile: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(pidFile).pipe(
      Effect.filterOrFail((pid) => pid.length > 0),
      Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 250 })
    )
  })

const waitUntilDead = (pid: string) =>
  isAlive(pid).pipe(
    Effect.filterOrFail((alive) => !alive),
    Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 250 })
  )

const collectFromWriter = (pidFile: string) =>
  Effect.scoped(
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(endlessWriter(pidFile))
      return yield* Effect.all({ exitCode: handle.exitCode, stdout: collectBounded(handle.stdout, 64 * 1024) }, {
        concurrency: "unbounded"
      })
    })
  )

describe("bounded collection around a child process", () => {
  it.live("kills the child when its output exceeds the budget", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const pidFile = path.join(yield* fs.makeTempDirectoryScoped(), "pid")

      const error = yield* collectFromWriter(pidFile).pipe(Effect.flip)

      expect(error).toMatchObject({ _tag: "ByteLimitExceeded", limit: 64 * 1024 })
      yield* waitUntilDead(yield* waitForPid(pidFile))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("kills the child when the caller's deadline interrupts the collection", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const pidFile = path.join(yield* fs.makeTempDirectoryScoped(), "pid")
      // The deadline starts once the child is running, so a slow start cannot
      // eat the budget before any output is collected.
      const pid = yield* Effect.scoped(
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const handle = yield* spawner.spawn(endlessWriter(pidFile))
          const pid = yield* waitForPid(pidFile)
          const result = yield* collectBounded(handle.stdout, Number.MAX_SAFE_INTEGER).pipe(
            Effect.timeoutOption("300 millis")
          )
          expect(result._tag).toBe("None")
          return pid
        })
      )

      yield* waitUntilDead(pid)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
