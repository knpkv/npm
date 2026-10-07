import { NodeServices } from "@effect/platform-node"
import { expect, layer } from "@effect/vitest"
import { Effect, FileSystem, Path, Schedule } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

layer(NodeServices.layer, { excludeTestServices: true })("Relay in CodeCommit web", (it) => {
  it.effect(
    "a server killed inside a confirmed comment resumes without posting it twice",
    () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* fs.makeTempDirectoryScoped()
        const marker = path.join(home, "posted.log")
        const child = path.join(import.meta.dirname, "fixtures", "relay-crash-child.ts")
        const tsx = path.join(import.meta.dirname, "..", "..", "..", "node_modules", ".bin", "tsx")
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

        const running = yield* spawner.spawn(ChildProcess.make(tsx, [child, "run", home, marker]))
        yield* fs.exists(marker).pipe(
          Effect.repeat({ until: (exists) => exists, schedule: Schedule.spaced("50 millis") }),
          Effect.timeout("30 seconds")
        )
        yield* running.kill({ killSignal: "SIGKILL" })
        // best-effort: the killed child's exit status says nothing; only the resumed run is under test.
        yield* running.exitCode.pipe(Effect.ignore)

        const resumed = yield* spawner.string(ChildProcess.make(tsx, [child, "resume", home, marker]))
        expect(resumed).toContain("RESUMED_AND_ANSWERED")
        expect(yield* fs.readFileString(marker)).toBe("posted LGTM\n")
      }).pipe(Effect.scoped),
    90_000
  )
})
