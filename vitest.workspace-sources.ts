/**
 * Points every `@knpkv/*` import in a test at the workspace package's source.
 *
 * A package's `exports` name its build output, so without this a test of
 * package A that imports package B runs B's last `dist/` build: edits to B's
 * source are invisible until someone rebuilds it, and a subpath B added since
 * the last build does not resolve at all. Each package's vitest config adds
 *
 * ```ts
 * resolve: { alias: workspaceSourceAlias }
 * ```
 *
 * and nothing else. The aliases are built from every workspace package's
 * `exports` map when the config loads, as exact-match patterns, so
 * `@knpkv/atlassian-common` never captures `@knpkv/atlassian-common/auth`.
 * An export that points into `dist/` but has no matching source file fails
 * config loading: falling back to `dist/` would bring back the stale build
 * this exists to avoid.
 *
 * Exports that already point at `src/`, and package-root files such as rly's
 * registry JSON, need no alias and are left to normal resolution. Packed-package
 * tests (`scripts/test-packed-*.ts`) install the packed tarballs and do not load
 * these configs.
 *
 * Configs that deliberately keep resolving built output:
 * - `packages/review/vitest.config.ts`: its guide-hydration test renders the
 *   built guide export and hydrates it with an esbuild client bundle, which
 *   ignores vite aliases; the server render must resolve `@knpkv/rly` the same
 *   way the client bundle does, from `dist/`.
 * - opt-in smoke, live and sandbox configs (`vitest.*smoke*`, `vitest.live*`,
 *   `vitest.sbx*`) and rly's Storybook config, which are not part of `pnpm test`.
 *
 * Suites that resolve `@knpkv/*` outside vitest still need a fresh `pnpm build`;
 * their test process runs source while the code they start runs `dist/`:
 * - herdr-approvals `test/http.test.ts`: spawns node/tsx, needs a fresh `pnpm build`.
 * - herdr-approvals `test/browser-bundle.test.ts`: bundles with esbuild, needs a fresh `pnpm build`.
 * - agent-usage `test/login.test.ts`, `test/version.test.ts`: spawn node/tsx, need a fresh `pnpm build`.
 * - control-center `test/runtime/offline-backup.test.ts`: runs the built CLI by design.
 */
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

interface SourceAlias {
  readonly find: RegExp
  readonly replacement: string
}

/** An `exports` value: a path, or conditions mapping to further values. */
type ExportTarget = string | { readonly [condition: string]: ExportTarget }
const ExportTarget: Schema.Codec<ExportTarget> = Schema.Union([
  Schema.String,
  Schema.Record(Schema.String, Schema.suspend(() => ExportTarget))
])

const Manifest = Schema.Struct({
  name: Schema.String,
  exports: Schema.optional(ExportTarget)
})
type Manifest = typeof Manifest.Type

const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))

const packagesDirectory = fileURLToPath(new URL("./packages/", import.meta.url))

/**
 * Build output directories and the source directory each one mirrors, checked in
 * order. Control Center's server build compiles `src/` into `dist/server/`.
 */
const defaultLayout = [["./dist/", "./src/"]] as const
const buildLayouts = new Map([
  ["@knpkv/control-center", [["./dist/server/", "./src/"], ["./dist/", "./src/"]] as const]
])

/** Built assets with no one-to-one source file; tests import the built file. */
const builtAssetExports = new Set(["@knpkv/review/guide/styles.css", "@knpkv/rly/styles.css"])

/** Built extension and the source extensions it may come from. */
const sourceExtensions = [[".js", [".ts", ".tsx"]], [".css", [".css"]]] as const

/** Package-root exports that are published as-is and have no build step. */
const unbuiltExportPrefixes = new Map([["@knpkv/rly", ["./registry/"]]])

/** A workspace export the aliases cannot map to source; fails config loading. */
class WorkspaceSourceAliasError extends Error {
  override readonly name = "WorkspaceSourceAliasError"
  readonly specifier: string
  readonly target: string | undefined
  constructor(specifier: string, target: string | undefined, reason: string) {
    super(`workspace source alias: ${specifier} -> ${target ?? "(no import/default target)"}: ${reason}`)
    this.specifier = specifier
    this.target = target
  }
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// A conditional export's runtime target; type-only conditions are not module targets.
const runtimeTarget = (target: ExportTarget): string | undefined => {
  if (Predicate.isString(target)) return target
  for (const condition of ["import", "default"]) {
    const nested = target[condition]
    const resolved = nested === undefined ? undefined : runtimeTarget(nested)
    if (resolved !== undefined) return resolved
  }
  return undefined
}

const sourceFor = (packageName: string, directory: string, target: string): string | undefined => {
  for (const [buildPrefix, sourcePrefix] of buildLayouts.get(packageName) ?? defaultLayout) {
    if (!target.startsWith(buildPrefix)) continue
    const relative = target.slice(buildPrefix.length)
    for (const [builtExtension, extensions] of sourceExtensions) {
      if (!relative.endsWith(builtExtension)) continue
      const stem = relative.slice(0, -builtExtension.length)
      for (const extension of extensions) {
        const candidate = join(directory, sourcePrefix, `${stem}${extension}`)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return undefined
}

const exportEntries = (manifest: Manifest): ReadonlyArray<readonly [string, ExportTarget]> =>
  manifest.exports === undefined
    ? []
    : Predicate.isString(manifest.exports)
    ? [[".", manifest.exports]]
    : Object.entries(manifest.exports)

const aliasesFor = (directory: string): ReadonlyArray<SourceAlias> => {
  const manifest = decodeManifest(readFileSync(join(directory, "package.json"), "utf8"))
  if (!manifest.name.startsWith("@knpkv/")) return []
  const aliases: Array<SourceAlias> = []
  for (const [key, value] of exportEntries(manifest)) {
    const specifier = key === "." ? manifest.name : `${manifest.name}/${key.slice(2)}`
    const target = runtimeTarget(value)
    if (target === undefined) throw new WorkspaceSourceAliasError(specifier, target, "no runtime target")
    if (target.startsWith("./src/")) continue
    if ((unbuiltExportPrefixes.get(manifest.name) ?? []).some((prefix) => target.startsWith(prefix))) continue
    if (!target.startsWith("./dist/")) {
      throw new WorkspaceSourceAliasError(specifier, target, "points outside dist/ and src/")
    }
    if (builtAssetExports.has(specifier)) continue
    if (key.includes("*")) throw new WorkspaceSourceAliasError(specifier, target, "wildcard dist export")
    const source = sourceFor(manifest.name, directory, target)
    if (source === undefined) throw new WorkspaceSourceAliasError(specifier, target, "no source file")
    aliases.push({ find: new RegExp(`^${escapeRegExp(specifier)}$`), replacement: source })
  }
  return aliases
}

/** Exact-match aliases from every `@knpkv/*` workspace export to its source file. */
export const workspaceSourceAlias: ReadonlyArray<SourceAlias> = readdirSync(packagesDirectory, {
  withFileTypes: true
})
  .filter((entry) => entry.isDirectory() && existsSync(join(packagesDirectory, entry.name, "package.json")))
  .flatMap((entry) => aliasesFor(join(packagesDirectory, entry.name)))
