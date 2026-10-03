/**
 * Shared facts about the effect-qb copy that ships inside this package.
 *
 * TEMPORARY: effect-qb has no release that supports Effect 4.0.0 (0.22–0.23 import the removed
 * `effect/unstable/sql` paths). The workspace patches it, but pnpm patches do not travel with a
 * published package, so `src` imports `./vendor/effect-qb/*.js` (development shims that re-export
 * the workspace-patched package) and the build replaces them in `dist/vendor/effect-qb` with the
 * patched runtime. Drop this
 * once an upstream effect-qb release supports Effect 4.0.0, and depend on it directly again.
 */
import * as Data from "effect/Data"

/** Entry points this package imports, mapped to their copied file. */
export const vendoredEntries: ReadonlyArray<{ readonly specifier: string; readonly file: string }> = [
  { specifier: "effect-qb", file: "index.js" },
  { specifier: "effect-qb/sqlite", file: "sqlite.js" }
]

export const vendorDirectory = "vendor/effect-qb"

/** Evidence that a copied file carries the workspace patch rather than the pristine release. */
export const patchedRuntimeMarkers = {
  forbidden: "effect/unstable/",
  required: "\"effect/sql/SqlClient\""
} satisfies Readonly<Record<"forbidden" | "required", string>>

export class VendoredEffectQbError extends Data.TaggedError("VendoredEffectQbError")<{
  readonly cause?: unknown
  readonly reason: string
}> {}

/** Describe why `source` is not the patched effect-qb runtime, or `undefined` when it is. */
export const unpatchedReason = (file: string, source: string): string | undefined =>
  source.includes(patchedRuntimeMarkers.forbidden)
    ? `${file} still imports ${patchedRuntimeMarkers.forbidden}`
    : source.includes(patchedRuntimeMarkers.required)
    ? undefined
    : `${file} does not import ${patchedRuntimeMarkers.required}`
