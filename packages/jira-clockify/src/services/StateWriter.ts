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
import * as Predicate from "effect/Predicate"
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

const parseStateFile = (content: string): TimerStateFile => {
  const parsed: unknown = JSON.parse(content)
  if (!Predicate.isObject(parsed)) return emptyState
  return {
    active: typeof parsed.active === "boolean" ? parsed.active : emptyState.active,
    ticketKey: typeof parsed.ticketKey === "string" || parsed.ticketKey === null
      ? parsed.ticketKey
      : emptyState.ticketKey,
    summary: typeof parsed.summary === "string" || parsed.summary === null ? parsed.summary : emptyState.summary,
    project: typeof parsed.project === "string" || parsed.project === null ? parsed.project : emptyState.project,
    startedAt: typeof parsed.startedAt === "string" || parsed.startedAt === null
      ? parsed.startedAt
      : emptyState.startedAt,
    startedAt_unix: typeof parsed.startedAt_unix === "number" || parsed.startedAt_unix === null
      ? parsed.startedAt_unix
      : emptyState.startedAt_unix,
    elapsed: typeof parsed.elapsed === "number" ? parsed.elapsed : emptyState.elapsed,
    clockifyEntryId: typeof parsed.clockifyEntryId === "string" || parsed.clockifyEntryId === null
      ? parsed.clockifyEntryId
      : emptyState.clockifyEntryId
  }
}

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
          try: () => parseStateFile(content),
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
