import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"

/** Where the data root came from: `CONTROL_CENTER_DATA_ROOT` as given, or the per-user default. */
export type ControlCenterDataRootChoice =
  | { readonly _tag: "Configured"; readonly dataRoot: string }
  | { readonly _tag: "Default"; readonly dataRoot: string }

/** No `CONTROL_CENTER_DATA_ROOT` and no absolute `HOME`, so there is no per-user default to use. */
export class ControlCenterHomeUnset extends Schema.TaggedError<ControlCenterHomeUnset>()(
  "ControlCenterHomeUnset",
  {}
) {}

/** The old working-directory root is on disk and the default root is not: starting would open an empty app. */
export class ControlCenterLegacyDataRootFound extends Schema.TaggedError<ControlCenterLegacyDataRootFound>()(
  "ControlCenterLegacyDataRootFound",
  { legacyRoot: Schema.String }
) {}

/** What to do about an old root: nothing, a notice, or refusing to start beside it. */
export type LegacyDataRootAction =
  | { readonly _tag: "None" }
  | { readonly _tag: "Notice"; readonly legacyRoot: string }
  | { readonly _tag: "Refuse"; readonly legacyRoot: string }

const DATA_ROOT_DIRECTORY = "control-center"
const LEGACY_DATA_ROOT = ".control-center"

/**
 * The environment the CLI reads at its boundary. `CONTROL_CENTER_DATA_ROOT` wins; otherwise the root is
 * `$XDG_DATA_HOME/control-center`, then `$HOME/.local/share/control-center`, so `npx` from any directory
 * finds the same data. A relative or empty `XDG_DATA_HOME` is ignored, as the XDG base directory spec says.
 */
export const chooseControlCenterDataRoot = Effect.fn("chooseControlCenterDataRoot")(function*(environment: {
  readonly configured: Option.Option<string>
  readonly xdgDataHome: Option.Option<string>
  readonly home: Option.Option<string>
}) {
  if (Option.isSome(environment.configured)) {
    return { _tag: "Configured", dataRoot: environment.configured.value } satisfies ControlCenterDataRootChoice
  }
  const path = yield* Path.Path
  const absolute = Option.filter((value: string) => path.isAbsolute(value))
  const xdgDataHome = absolute(environment.xdgDataHome)
  if (Option.isSome(xdgDataHome)) {
    return {
      _tag: "Default",
      dataRoot: path.join(xdgDataHome.value, DATA_ROOT_DIRECTORY)
    } satisfies ControlCenterDataRootChoice
  }
  const home = absolute(environment.home)
  if (Option.isNone(home)) return yield* new ControlCenterHomeUnset()
  return {
    _tag: "Default",
    dataRoot: path.join(home.value, ".local", "share", DATA_ROOT_DIRECTORY)
  } satisfies ControlCenterDataRootChoice
})

/**
 * The working-directory `.control-center` the CLI used before the per-user default, when the default is in use
 * and points elsewhere. The caller checks it exists; nothing here reads or moves it.
 */
export const legacyDataRootCandidate = Effect.fn("legacyDataRootCandidate")(function*(
  choice: ControlCenterDataRootChoice
) {
  if (choice._tag === "Configured") return Option.none<string>()
  const path = yield* Path.Path
  const legacy = path.resolve(LEGACY_DATA_ROOT)
  return legacy === path.resolve(choice.dataRoot) ? Option.none<string>() : Option.some(legacy)
})

/**
 * An old root still on disk while the default root does not exist yet refuses the start, so an upgrade never
 * opens an empty app with a fresh pairing code beside the owner's data. Once the default exists, or the command
 * is `restore` (which creates it from a backup), the old root only gets the notice.
 */
export const legacyDataRootAction = (input: {
  readonly legacyRoot: Option.Option<string>
  readonly legacyExists: boolean
  readonly defaultExists: boolean
  readonly creatingDefault: boolean
}): LegacyDataRootAction => {
  if (Option.isNone(input.legacyRoot) || !input.legacyExists) return { _tag: "None" }
  return input.defaultExists || input.creatingDefault
    ? { _tag: "Notice", legacyRoot: input.legacyRoot.value }
    : { _tag: "Refuse", legacyRoot: input.legacyRoot.value }
}

/**
 * The stderr lines for an old root that is still on disk. A data root is a claim bound to its basename, so a
 * plain move breaks it: the notice offers keeping it with the override, or moving it with backup and restore,
 * which publish a valid root at the new default. A refused start also says how to start fresh instead.
 */
export const legacyDataRootNotice = (paths: {
  readonly legacyRoot: string
  readonly dataRoot: string
  readonly refused: boolean
}): string =>
  [
    ...(paths.refused ? ["Control Center did not start, so it would not open an empty app beside your data."] : []),
    `Control Center found data at ${paths.legacyRoot}, its old location. It now uses ${paths.dataRoot}.`,
    `To keep using the old data, start it with CONTROL_CENTER_DATA_ROOT=${paths.legacyRoot} control-center.`,
    `To move it, stop Control Center, then run CONTROL_CENTER_DATA_ROOT=${paths.legacyRoot} control-center backup <archive>`,
    `and control-center restore <archive>.`,
    ...(paths.refused ? [`To start fresh instead, set CONTROL_CENTER_DATA_ROOT=${paths.dataRoot}.`] : []),
    "Nothing was moved."
  ].join("\n")
