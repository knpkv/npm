/**
 * Atomic timer state persistence to `~/.jcf/state.json`.
 *
 * **Mental model**
 *
 * - **Atomic writes**: Write goes to a `.tmp` file then `rename` — prevents corruption if
 *   the process crashes mid-write.
 * - **External consumption**: The state file is read by the Neovim plugin and statusline
 *   integrations to show timer state outside the TUI.
 *
 * @module
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import { HomeDirectory } from "./HomeDirectory.js"

export interface TimerStateFile {
  readonly active: boolean
  readonly ticketKey: string | null
  readonly summary: string | null
  readonly project: string | null
  readonly startedAt: string | null
  readonly startedAt_unix: number | null
  readonly elapsed: number
  readonly clockifyEntryId: string | null
}

const emptyState: TimerStateFile = {
  active: false,
  ticketKey: null,
  summary: null,
  project: null,
  startedAt: null,
  startedAt_unix: null,
  elapsed: 0,
  clockifyEntryId: null
}

export interface StateWriterShape {
  readonly write: (state: TimerStateFile) => Effect.Effect<void>
  readonly read: Effect.Effect<TimerStateFile>
  readonly clear: Effect.Effect<void>
}

export class StateWriter extends Context.Service<StateWriter, StateWriterShape>()("jcf/StateWriter") {}

const STATE_DIR = ".jcf"
const STATE_FILE = "state.json"

export const layer = Layer.effect(
  StateWriter,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = (yield* HomeDirectory).path
    const dir = path.join(home, STATE_DIR)
    const filePath = path.join(dir, STATE_FILE)

    const ensureDir = Effect.gen(function*() {
      const exists = yield* fs.exists(dir)
      if (!exists) yield* fs.makeDirectory(dir, { recursive: true })
    })

    return {
      write: (state) =>
        Effect.gen(function*() {
          yield* ensureDir
          const tmpPath = `${filePath}.tmp`
          yield* fs.writeFileString(tmpPath, JSON.stringify(state, null, 2))
          yield* fs.rename(tmpPath, filePath)
        }).pipe(Effect.catch(() => Effect.void)),

      read: Effect.gen(function*() {
        const exists = yield* fs.exists(filePath)
        if (!exists) return emptyState
        const content = yield* fs.readFileString(filePath)
        return yield* Effect.try({
          try: () => JSON.parse(content) as TimerStateFile,
          catch: () => emptyState
        })
      }).pipe(Effect.catch(() => Effect.succeed(emptyState))),

      clear: Effect.gen(function*() {
        yield* ensureDir
        const tmpPath = `${filePath}.tmp`
        yield* fs.writeFileString(tmpPath, JSON.stringify(emptyState, null, 2))
        yield* fs.rename(tmpPath, filePath)
      }).pipe(Effect.catch(() => Effect.void))
    }
  })
)
