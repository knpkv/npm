/**
 * User configuration persistence for jcf defaults (JQL, project, billable).
 *
 * **Mental model**
 *
 * - **File-backed with defaults**: Reads `~/.jcf/config.json`, merging stored values over
 *   {@link defaultJcfConfig}. Missing or corrupt files silently fall back to defaults.
 * - **Partial updates**: {@link ConfigServiceShape.set} merges a patch over the current config.
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

export interface JcfConfig {
  readonly defaultJql: string
  readonly refreshInterval: number
  readonly projectMap: Record<string, string>
  readonly workspaceId: string | null
  readonly defaultProjectId: string | null
  readonly defaultProjectName: string | null
  readonly defaultBillable: boolean
  /**
   * Session Roots: directory prefixes (`~` allowed) whose Agent Sessions may become Proposed
   * Worklogs. Empty means nothing is opted in, so `reconcile --agent` finds nothing — an
   * allowlist, because a denylist grows with every side project.
   */
  readonly sessionRoots: ReadonlyArray<string>
  /**
   * Standing Attributions: directory prefix → Issue Key, for recurring work with no natural
   * ticket (release notes, known-issues documents). Matched longest-prefix-first, and always
   * loses to a branch or path signal, so adding one can only ever add attribution.
   */
  readonly sessionTicketMap: Record<string, string>
  /**
   * Idle Cap in seconds: the longest gap between two Session Activity events still counted as
   * work. 5 minutes is the only setting that produced defensible daily totals over the author's
   * transcripts; 15 gave 6–12h days and 30 gave 11–13h.
   */
  readonly sessionIdleCapSeconds: number
  /**
   * Below this Coding Agent confidence, an attribution is reported but never offered for
   * confirmation, so "yes" at the confirm prompt stays usually-correct.
   */
  readonly sessionConfidenceFloor: number
}

/** The values every unset field falls back to, and what `jcf config reset` restores. */
export const defaultJcfConfig: JcfConfig = {
  defaultJql: "assignee = currentUser() AND status != Done ORDER BY updated DESC",
  refreshInterval: 30,
  projectMap: {},
  workspaceId: null,
  defaultProjectId: null,
  defaultProjectName: null,
  defaultBillable: true,
  sessionRoots: [],
  sessionTicketMap: {},
  sessionIdleCapSeconds: 300,
  sessionConfidenceFloor: 0.7
}

export interface ConfigServiceShape {
  readonly get: Effect.Effect<JcfConfig>
  readonly set: (patch: Partial<JcfConfig>) => Effect.Effect<void>
  readonly configDir: Effect.Effect<string>
}

export class ConfigService extends Context.Service<ConfigService, ConfigServiceShape>()("jcf/ConfigService") {}

const CONFIG_DIR = ".jcf"
const CONFIG_FILE = "config.json"

const stringRecord = (value: unknown): Record<string, string> | undefined => {
  if (!Predicate.isObject(value)) return undefined
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return undefined
    result[key] = entry
  }
  return result
}

const stringArray = (value: unknown): ReadonlyArray<string> | undefined => {
  if (!Array.isArray(value)) return undefined
  return value.every((entry) => typeof entry === "string") ? value : undefined
}

/**
 * A finite, positive number of seconds.
 *
 * Zero is rejected rather than merely odd: an Idle Cap of zero makes every presence window
 * zero-length, so both `reconcile --agent` and `watch` report nothing to propose, forever, with
 * nothing on screen to explain it. `jcf config set idle-cap` already refuses it — this is the same
 * rule for the file, which is the other way in.
 */
const positiveSeconds = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined

/**
 * A confidence in `[0, 1]`, or nothing.
 *
 * Narrower than {@link nonNegativeNumber} because the value is compared against a confidence that is
 * itself clamped to `[0, 1]`. There is no `jcf config set` subcommand for this field, so hand-editing
 * the file is the only way to set it — which is exactly where `70` gets written for "70%". Accepting
 * it would withhold every Coding Agent attribution from then on, permanently and with nothing to
 * point at. Out of range falls back to the default instead.
 */
const confidence = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined

/**
 * The stored fields worth keeping, out of whatever `~/.jcf/config.json` happens to contain.
 *
 * Exported for testing: this is the one place a hand-edited file meets the rest of jcf, and a value
 * that gets through here wrongly is one that changes behaviour with nothing on screen to explain it.
 */
export const parseConfigPatch = (content: string): Partial<JcfConfig> => {
  const parsed: unknown = JSON.parse(content)
  if (!Predicate.isObject(parsed)) return {}
  const projectMap = stringRecord(parsed.projectMap)
  const sessionRoots = stringArray(parsed.sessionRoots)
  const sessionTicketMap = stringRecord(parsed.sessionTicketMap)
  const sessionIdleCapSeconds = positiveSeconds(parsed.sessionIdleCapSeconds)
  const sessionConfidenceFloor = confidence(parsed.sessionConfidenceFloor)
  return {
    ...(sessionRoots !== undefined ? { sessionRoots } : {}),
    ...(sessionTicketMap !== undefined ? { sessionTicketMap } : {}),
    ...(sessionIdleCapSeconds !== undefined ? { sessionIdleCapSeconds } : {}),
    ...(sessionConfidenceFloor !== undefined ? { sessionConfidenceFloor } : {}),
    ...(typeof parsed.defaultJql === "string" ? { defaultJql: parsed.defaultJql } : {}),
    ...(typeof parsed.refreshInterval === "number" ? { refreshInterval: parsed.refreshInterval } : {}),
    ...(projectMap !== undefined ? { projectMap } : {}),
    ...(typeof parsed.workspaceId === "string" || parsed.workspaceId === null
      ? { workspaceId: parsed.workspaceId }
      : {}),
    ...(typeof parsed.defaultProjectId === "string" || parsed.defaultProjectId === null
      ? { defaultProjectId: parsed.defaultProjectId }
      : {}),
    ...(typeof parsed.defaultProjectName === "string" || parsed.defaultProjectName === null
      ? { defaultProjectName: parsed.defaultProjectName }
      : {}),
    ...(typeof parsed.defaultBillable === "boolean" ? { defaultBillable: parsed.defaultBillable } : {})
  }
}

export const layer = Layer.effect(
  ConfigService,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = (yield* HomeDirectory).path
    const dir = path.join(home, CONFIG_DIR)
    const filePath = path.join(dir, CONFIG_FILE)

    const ensureDir = Effect.gen(function*() {
      const exists = yield* fs.exists(dir)
      if (!exists) yield* fs.makeDirectory(dir, { recursive: true })
    })

    const read: Effect.Effect<JcfConfig> = Effect.gen(function*() {
      const exists = yield* fs.exists(filePath)
      if (!exists) return defaultJcfConfig
      const content = yield* fs.readFileString(filePath)
      const parsed = yield* Effect.try({
        try: () => parseConfigPatch(content),
        catch: () => ({})
      })
      return { ...defaultJcfConfig, ...parsed }
    }).pipe(Effect.catch(() => Effect.succeed(defaultJcfConfig)))

    const write = (config: JcfConfig) =>
      Effect.gen(function*() {
        yield* ensureDir
        yield* fs.writeFileString(filePath, JSON.stringify(config, null, 2))
      })

    return {
      get: read,
      set: (patch) =>
        Effect.gen(function*() {
          const current = yield* read
          yield* write({ ...current, ...patch })
        }).pipe(Effect.catch(() => Effect.void)),
      configDir: Effect.succeed(dir)
    }
  })
)
