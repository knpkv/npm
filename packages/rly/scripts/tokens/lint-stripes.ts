/**
 * Fails when any stylesheet draws a one-sided accent stripe (see accent-stripes.ts), splits words
 * (see word-breaks.ts) or measures in a glyph of the current font (see glyph-units.ts): every rly
 * source and story stylesheet, and every product package's `src` CSS. Stripes that product packages
 * already had are listed in `stripe-baseline.json` and allowed until removed (see stripe-baseline.ts).
 * Run with `pnpm lint:stripes`; part of the root `lint:static`.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import { findAccentStripes } from "./accent-stripes.js"
import { findGlyphUnits } from "./glyph-units.js"
import { compareToBaseline, type StripeBaselineEntry } from "./stripe-baseline.js"
import { findWordSplits } from "./word-breaks.js"

class StripeLintError extends Data.TaggedError("StripeLintError")<{
  readonly reason: string
}> {
  override get message(): string {
    return this.reason
  }
}

const listSources: (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string
) => Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError> = Effect.fn("rly.listStripeSources")(
  function*(fs, path, directory) {
    const files: Array<string> = []
    if (!(yield* fs.exists(directory))) return files
    for (const entry of yield* fs.readDirectory(directory)) {
      const absolute = path.join(directory, entry)
      const info = yield* fs.stat(absolute)
      if (info.type === "Directory") {
        if (["node_modules", "dist", "generated", "storybook-static", "test-results"].includes(entry)) continue
        for (const file of yield* listSources(fs, path, absolute)) files.push(file)
      } else if (info.type === "File" && entry.endsWith(".css")) files.push(absolute)
    }
    return files
  }
)

const StripeBaseline = Schema.Array(Schema.Struct({ declaration: Schema.String, path: Schema.String }))
const decodeBaseline = (text: string): Effect.Effect<ReadonlyArray<StripeBaselineEntry>, StripeLintError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(StripeBaseline))(text).pipe(
    Effect.mapError(() =>
      new StripeLintError({ reason: "scripts/tokens/stripe-baseline.json is not a valid baseline" })
    )
  )

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const packageRoot = path.dirname(path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)))))
  const repoRoot = path.dirname(path.dirname(packageRoot))
  const packagesDir = path.join(repoRoot, "packages")
  const products: Array<string> = []
  for (const name of yield* fs.readDirectory(packagesDir)) {
    if (name === path.basename(packageRoot)) continue
    if ((yield* fs.stat(path.join(packagesDir, name))).type === "Directory") {
      products.push(path.join(packagesDir, name, "src"))
    }
  }
  const roots = [
    ...["foundations", "primitives", "patterns", "diff", "styles"].map((directory) =>
      path.join(packageRoot, "src", directory)
    ),
    path.join(packageRoot, "stories"),
    ...products.sort()
  ]
  const baselinePath = path.join(packageRoot, "scripts", "tokens", "stripe-baseline.json")
  const baseline = yield* decodeBaseline(yield* fs.readFileString(baselinePath))
  const files: Array<string> = []
  for (const root of roots) for (const file of yield* listSources(fs, path, root)) files.push(file)
  const violations = []
  for (const file of files.sort()) {
    const source = yield* fs.readFileString(file)
    const relativePath = path.relative(repoRoot, file)
    for (
      const violation of [
        ...findAccentStripes(relativePath, source),
        ...findWordSplits(relativePath, source),
        ...findGlyphUnits(relativePath, source)
      ]
    ) {
      violations.push(violation)
    }
  }
  const { fixed, fresh } = compareToBaseline(violations, baseline)
  if (fresh.length > 0 || fixed.length > 0) {
    return yield* new StripeLintError({
      reason: [
        ...fresh.map((violation) =>
          `${violation.path}:${violation.line}:${violation.column} one-sided stripe or mid-word break: ${violation.declaration}`
        ),
        ...fixed.map((entry) =>
          `${entry.path}: no longer draws "${entry.declaration}"; remove it from scripts/tokens/stripe-baseline.json`
        )
      ].join("\n")
    })
  }
  yield* Console.log(
    `stripe policy checked ${files.length} stylesheets; ${baseline.length} known stripes and word splits remain in the baseline`
  )
})

NodeRuntime.runMain(
  program.pipe(
    Effect.tapError((error) => Console.error(error.message)),
    // The lint script is the executable boundary for Node services.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(NodeServices.layer)
  ),
  { disableErrorReporting: true }
)
