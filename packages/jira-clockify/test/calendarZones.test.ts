import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

// @effect-diagnostics strictEffectProvide:off

const Output = Schema.Struct({
  zone: Schema.String,
  spring: Schema.Array(Schema.String),
  ordinary: Schema.Array(Schema.String),
  lordHowe: Schema.Array(Schema.String)
})
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Output))

// Resolved from this file, not the cwd: the root gate runs every package's tests from the repo root.
const renderIn = (zone: string) =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const path = yield* Path.Path
    const fixture = yield* path.fromFileUrl(new URL("./fixtures/calendarZone.ts", import.meta.url))
    const packageRoot = yield* path.fromFileUrl(new URL("..", import.meta.url))
    const output = yield* spawner.string(ChildProcess.make(
      "node",
      ["--import", "tsx", fixture],
      { cwd: packageRoot, env: { TZ: zone }, extendEnv: true }
    ))
    return yield* decode(output)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const cells = (line: string): string => line.slice(8)

it.effect("renders New York spring-forward by elapsed minutes in a startup-pinned process", () =>
  renderIn("America/New_York").pipe(
    Effect.map((output) => {
      expect(output.zone).toBe("America/New_York")
      expect(output.spring.map((line) => line.trimStart().slice(0, 3))).toEqual(["01h", "03h"])
      expect(output.spring.flatMap((line) => [...cells(line)]).filter((cell) => cell === "#")).toHaveLength(20)
      expect(output.ordinary.flatMap((line) => [...cells(line)]).filter((cell) => cell === "#")).toHaveLength(80)
    })
  ))

it.effect("keeps both Lord Howe half-hour occurrences in local columns", () =>
  renderIn("Australia/Lord_Howe").pipe(
    Effect.map((output) => {
      expect(output.zone).toBe("Australia/Lord_Howe")
      expect(output.lordHowe).toHaveLength(2)
      expect(output.lordHowe.map((line) => line.trimStart().slice(0, 3))).toEqual(["01h", "01h"])
      const [firstOccurrence, secondOccurrence] = output.lordHowe
      expect(firstOccurrence).toBeDefined()
      expect(secondOccurrence).toBeDefined()
      if (firstOccurrence === undefined || secondOccurrence === undefined) return
      expect(cells(firstOccurrence).slice(35, 45)).toBe("#".repeat(10))
      expect(cells(secondOccurrence).slice(35, 45)).toBe("=".repeat(10))
    })
  ))
