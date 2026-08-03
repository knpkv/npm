import { describe, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

import {
  collectBoundedGitProcess,
  failClosedVisualClassification,
  recoverVisualGitFailure,
  VisualGitError
} from "../../scripts/visual/classify-git-changes-effect.js"

const makeHandle = (
  stdout: Stream.Stream<Uint8Array>,
  kills: Array<"killed"> = []
): ChildProcessSpawner.ChildProcessHandle =>
  ChildProcessSpawner.makeHandle({
    all: stdout,
    exitCode: Effect.never,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        kills.push("killed")
      }),
    pid: ChildProcessSpawner.ProcessId(42),
    stderr: Stream.empty,
    stdin: Sink.drain,
    stdout,
    unref: Effect.succeed(Effect.void)
  })

describe("visual Git classifier Effect boundary", () => {
  it.effect("fails closed for expected Git and catalog errors", () =>
    Effect.gen(function*() {
      const classification = yield* recoverVisualGitFailure(
        Effect.fail(new VisualGitError({ reason: "Git command failed" }))
      )

      expect(classification).toEqual(failClosedVisualClassification)
    }))

  it.effect("preserves interruption for the runtime lifecycle", () =>
    Effect.gen(function*() {
      const exit = yield* recoverVisualGitFailure(Effect.interrupt).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }))

  it.effect("preserves defects for runtime error reporting", () =>
    Effect.gen(function*() {
      const exit = yield* recoverVisualGitFailure(Effect.die("classifier defect")).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true)
    }))

  it.effect("decodes a multibyte character split exactly across the byte bound", () =>
    Effect.gen(function*() {
      const handle = makeHandle(Stream.make(
        Uint8Array.of(0xf0, 0x9f),
        Uint8Array.of(0x98, 0x80)
      ))
      const output = yield* collectBoundedGitProcess(
        ChildProcessSpawner.makeHandle({
          ...handle,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0))
        }),
        4
      )

      expect(output).toBe("😀")
    }))

  it.effect("terminates the child as soon as stdout crosses the byte bound", () =>
    Effect.gen(function*() {
      const kills: Array<"killed"> = []
      const handle = makeHandle(
        Stream.make(Uint8Array.of(1, 2), Uint8Array.of(3, 4, 5)),
        kills
      )
      const failure = yield* collectBoundedGitProcess(handle, 4).pipe(Effect.flip)

      expect(failure).toEqual(
        new VisualGitError({
          reason: "Git stdout exceeded the classifier bound"
        })
      )
      expect(kills).toEqual(["killed"])
    }))
})
