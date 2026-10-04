/**
 * Claude limit samples written by claude-statusline: one JSON line each time a window's reading
 * moves, read like a transcript (byte cursor, complete lines only) into Claude Limit Snapshots.
 *
 * **Mental model**
 *
 * - **A second witness to the same windows.** Samples land next to the OAuth polls under source
 *   `claude-statusline`; a Claude window is one series whichever source observed it.
 * - **The file is local.** Samples are stored under this Machine; the hostname a line carries only
 *   tells duplicates apart.
 * - **Duplicates are expected.** Two renders, or a crash between the append and the writer's own
 *   bookkeeping, can repeat a line, so a sample equal to its window's last kept one is dropped.
 * - **Nothing is passed over quietly.** A line that does not decode, or speaks another format
 *   version, is skipped and counted.
 *
 * Format v1: `{"v":1,"observedAt":<epoch ms>,"machine":"<hostname>","window":"five_hour"|"seven_day"|"spend",
 * "usedPercentage":<number>,"resetsAt":<epoch ms|null>}`; unknown fields are ignored.
 *
 * @module
 */
import { Option, Schema } from "effect"
import type { LimitSnapshot, WindowMinutes } from "./Model.js"
import { countSkip, noSkips, type ReadResult, type SkipCounts, type SourceFile, type SourceLine } from "./Readers.js"

const ClaudeLimitSample = Schema.fromJsonString(Schema.Struct({
  v: Schema.Literal(1),
  observedAt: Schema.Int,
  machine: Schema.NonEmptyString,
  window: Schema.Literals(["five_hour", "seven_day", "spend"]),
  usedPercentage: Schema.Finite,
  resetsAt: Schema.NullOr(Schema.Int)
}))
const decodeSample = Schema.decodeUnknownOption(ClaudeLimitSample)

/** The last sample kept per machine and window, carried in the cursor to drop repeats. */
export const SamplesState = Schema.Struct({
  kept: Schema.Record(Schema.String, Schema.String)
})
export type SamplesState = typeof SamplesState.Type

export const initialSamplesState: SamplesState = { kept: {} }

const windowMinutes = (window: "five_hour" | "seven_day" | "spend"): WindowMinutes =>
  window === "five_hour" ? 300 : window === "seven_day" ? 10_080 : null

/** Reads one chunk of samples. Pure: the ingest pass owns the file and the cursor. */
export const readClaudeLimitSamples = (
  file: SourceFile,
  lines: ReadonlyArray<SourceLine>,
  state: SamplesState
): ReadResult<SamplesState> => {
  const kept = new Map(Object.entries(state.kept))
  const snapshots: Array<LimitSnapshot> = []
  let skipped: SkipCounts = noSkips
  for (const line of lines) {
    const decoded = decodeSample(line.text)
    if (Option.isNone(decoded)) {
      skipped = countSkip(skipped, "unparseableLine")
      continue
    }
    const sample = decoded.value
    const key = `${sample.machine}\u0000${sample.window}`
    const signature = `${sample.resetsAt ?? "null"}\u0000${sample.usedPercentage}`
    if (kept.get(key) === signature) continue
    kept.set(key, signature)
    snapshots.push({
      agent: "claude",
      machine: file.machine,
      source: "claude-statusline",
      label: sample.window,
      windowMinutes: windowMinutes(sample.window),
      observedAt: sample.observedAt,
      reading: { _tag: "Known", usedPercent: sample.usedPercentage, resetsAt: sample.resetsAt }
    })
  }
  return { events: [], snapshots, balances: [], skipped, state: { kept: Object.fromEntries(kept) } }
}
