import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"

import { RunnerFailure } from "../src/schema.js"

/** Local shared-machine policy applies only on hosts exposing Linux memory information. */
export const checkBaseMemory = Effect.fn("DesignConformance.checkBaseMemory")(function*() {
  const fs = yield* FileSystem.FileSystem
  if (!(yield* fs.exists("/proc/meminfo"))) return
  const memory = yield* fs.readFileString("/proc/meminfo")
  const available = Number(/MemAvailable:\s+(\d+)/u.exec(memory)?.[1])
  if (!Number.isFinite(available) || available < 3 * 1024 * 1024) {
    return yield* new RunnerFailure({ detail: "Base capture needs at least 3 GiB MemAvailable" })
  }
})
