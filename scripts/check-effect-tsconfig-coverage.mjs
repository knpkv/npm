import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import assert from "node:assert/strict"
import { URL } from "node:url"

import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Stdio from "effect/Stdio"
import * as TypeScript from "typescript"

const effectPluginName = "@effect/language-service"
const ignoredDirectories = new Set(["dist", "generated", "node_modules"])
const dependencySections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
const strictDiagnostics = ["strictBooleanExpressions", "strictEffectProvide"]

class EffectTsconfigCoverageError extends Data.TaggedError("EffectTsconfigCoverageError") {
  get message() {
    return this.reason
  }
}

const fail = (reason, cause) => Effect.fail(new EffectTsconfigCoverageError({ cause, reason }))

const declaresEffect = (manifest) =>
  dependencySections.some((section) =>
    Object.keys(manifest[section] ?? {}).some((name) => name === "effect" || name.startsWith("@effect/"))
  )

const checkCoversRootTsconfig = (checkScript) => {
  if (!Predicate.isString(checkScript)) return false
  for (const segment of checkScript.split(/&&|\|\||;/u)) {
    const executable = segment.match(/(?:^|\s)(?:tsc|tspc|tsgo)(?:\s|$)/u)
    if (executable === null) continue
    const command = segment.slice(executable.index).trim()
    const project = command.match(/(?:^|\s)(?:-p|--project)\s+([^\s]+)/u)?.[1]
    if (project !== undefined) {
      if (project.replaceAll(/["']/gu, "").replace(/^\.\//u, "") === "tsconfig.json") return true
      continue
    }
    const build = command.match(/(?:^|\s)(?:-b|--build)(?:\s+([^\s-][^\s]*))?/u)
    if (build === null) return true
    const target = build[1]?.replaceAll(/["']/gu, "").replace(/^\.\//u, "")
    if (target === undefined || target === "tsconfig.json" || target === ".") return true
  }
  return false
}

const validatePackageRecords = (records) => {
  const diagnostics = []
  for (const record of records) {
    if (!record.effectPackage) continue
    if (!record.checkCoversRoot) {
      diagnostics.push(`${record.name}: scripts.check must type-check the package root tsconfig.json`)
    }
    if (record.sourceConfigs.length === 0) {
      diagnostics.push(`${record.name}: no source-bearing TypeScript configuration was found`)
      continue
    }
    for (const config of record.sourceConfigs) {
      if (!config.hasEffectPlugin) {
        diagnostics.push(`${record.name}: ${config.path} does not load ${effectPluginName}`)
        continue
      }
      if (!config.includesEffectNamespaces) {
        diagnostics.push(`${record.name}: ${config.path} does not configure Effect package namespaces`)
      }
      if (config.ignoreWarnings !== false || config.ignoreErrors !== false) {
        diagnostics.push(`${record.name}: ${config.path} must make Effect warnings and errors affect the tsc exit code`)
      }
      if (config.includeSuggestions !== false || config.ignoreSuggestions !== false) {
        diagnostics.push(
          `${record.name}: ${config.path} must keep successful tsc output clean and never make surfaced suggestions non-blocking`
        )
      }
      for (const diagnostic of strictDiagnostics) {
        if (config.diagnosticSeverity?.[diagnostic] === undefined || config.diagnosticSeverity[diagnostic] === "off") {
          diagnostics.push(`${record.name}: ${config.path} must enable Effect diagnostic ${diagnostic}`)
        }
      }
    }
  }
  return diagnostics
}

const runSelfTest = () => {
  const coveredConfig = {
    hasEffectPlugin: true,
    ignoreErrors: false,
    ignoreSuggestions: false,
    ignoreWarnings: false,
    includeSuggestions: false,
    includesEffectNamespaces: true,
    diagnosticSeverity: {
      strictBooleanExpressions: "suggestion",
      strictEffectProvide: "suggestion"
    },
    path: "tsconfig.json"
  }
  assert.deepEqual(
    validatePackageRecords([
      {
        checkCoversRoot: true,
        effectPackage: true,
        name: "@fixture/valid",
        sourceConfigs: [coveredConfig]
      },
      {
        checkCoversRoot: false,
        effectPackage: false,
        name: "@fixture/non-effect",
        sourceConfigs: []
      }
    ]),
    []
  )
  assert.deepEqual(
    validatePackageRecords([
      {
        checkCoversRoot: false,
        effectPackage: true,
        name: "@fixture/missing-check",
        sourceConfigs: [coveredConfig]
      }
    ]),
    ["@fixture/missing-check: scripts.check must type-check the package root tsconfig.json"]
  )
  assert.deepEqual(
    validatePackageRecords([
      {
        checkCoversRoot: true,
        effectPackage: true,
        name: "@fixture/missing-plugin",
        sourceConfigs: [{ ...coveredConfig, hasEffectPlugin: false }]
      },
      {
        checkCoversRoot: true,
        effectPackage: true,
        name: "@fixture/ignored-warning",
        sourceConfigs: [{ ...coveredConfig, ignoreWarnings: true }]
      },
      {
        checkCoversRoot: true,
        effectPackage: true,
        name: "@fixture/incomplete-policy",
        sourceConfigs: [{ ...coveredConfig, includesEffectNamespaces: false }]
      },
      {
        checkCoversRoot: true,
        effectPackage: true,
        name: "@fixture/non-blocking-suggestions",
        sourceConfigs: [{ ...coveredConfig, includeSuggestions: true, ignoreSuggestions: true }]
      },
      {
        checkCoversRoot: true,
        effectPackage: true,
        name: "@fixture/missing-strict-pattern",
        sourceConfigs: [
          {
            ...coveredConfig,
            diagnosticSeverity: { ...coveredConfig.diagnosticSeverity, strictEffectProvide: "off" }
          }
        ]
      }
    ]),
    [
      "@fixture/missing-plugin: tsconfig.json does not load @effect/language-service",
      "@fixture/ignored-warning: tsconfig.json must make Effect warnings and errors affect the tsc exit code",
      "@fixture/incomplete-policy: tsconfig.json does not configure Effect package namespaces",
      "@fixture/non-blocking-suggestions: tsconfig.json must keep successful tsc output clean and never make surfaced suggestions non-blocking",
      "@fixture/missing-strict-pattern: tsconfig.json must enable Effect diagnostic strictEffectProvide"
    ]
  )
  assert.equal(checkCoversRootTsconfig("tsc --noEmit && tsc -p scripts/tsconfig.json"), true)
  assert.equal(checkCoversRootTsconfig("tsc -b tsconfig.json"), true)
  assert.equal(checkCoversRootTsconfig("tsc -p scripts/tsconfig.json"), false)
}

const decodeJson = Effect.fn("EffectTsconfigCoverage.decodeJson")(function* (content, location) {
  return yield* Effect.try({
    try: () => JSON.parse(content),
    catch: (cause) => new EffectTsconfigCoverageError({ cause, reason: `${location}: invalid JSON` })
  })
})

const findTsconfigs = Effect.fn("EffectTsconfigCoverage.findTsconfigs")(function* (root) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const pending = [root]
  const configs = []

  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) continue
    const entries = (yield* fileSystem.readDirectory(directory)).toSorted()
    for (const entry of entries) {
      const absolute = path.join(directory, entry)
      const info = yield* fileSystem.stat(absolute)
      if (info.type === "Directory") {
        if (!ignoredDirectories.has(entry)) pending.push(absolute)
      } else if (info.type === "File" && /^tsconfig.*\.jsonc?$/u.test(entry)) {
        configs.push(absolute)
      }
    }
  }

  return configs.toSorted()
})

const inspectTsconfig = Effect.fn("EffectTsconfigCoverage.inspectTsconfig")(function* (configPath, configDirectory) {
  return yield* Effect.try({
    try: () => {
      const read = TypeScript.readConfigFile(configPath, TypeScript.sys.readFile)
      if (read.error !== undefined) {
        throw new EffectTsconfigCoverageError({
          reason: TypeScript.flattenDiagnosticMessageText(read.error.messageText, "\n")
        })
      }
      const parsed = TypeScript.parseJsonConfigFileContent(
        read.config,
        TypeScript.sys,
        configDirectory,
        undefined,
        configPath
      )
      if (parsed.errors.length > 0) {
        throw new EffectTsconfigCoverageError({
          reason: parsed.errors
            .map((error) => TypeScript.flattenDiagnosticMessageText(error.messageText, "\n"))
            .join("\n")
        })
      }
      if (parsed.fileNames.length === 0) return undefined
      const plugin = parsed.options.plugins?.find(({ name }) => name === effectPluginName)
      return {
        hasEffectPlugin: plugin !== undefined,
        diagnosticSeverity: plugin?.diagnosticSeverity,
        ignoreErrors: plugin?.ignoreEffectErrorsInTscExitCode,
        ignoreSuggestions: plugin?.ignoreEffectSuggestionsInTscExitCode,
        ignoreWarnings: plugin?.ignoreEffectWarningsInTscExitCode,
        includeSuggestions: plugin?.includeSuggestionsInTsc,
        includesEffectNamespaces:
          Array.isArray(plugin?.namespaceImportPackages) &&
          plugin.namespaceImportPackages.includes("effect") &&
          plugin.namespaceImportPackages.includes("@effect/*")
      }
    },
    catch: (cause) => new EffectTsconfigCoverageError({ cause, reason: `Could not inspect ${configPath}` })
  })
})

const inspectWorkspace = Effect.fn("EffectTsconfigCoverage.inspectWorkspace")(function* (packagesRoot) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const records = []
  const entries = (yield* fileSystem.readDirectory(packagesRoot)).toSorted()

  for (const entry of entries) {
    const packageDirectory = path.join(packagesRoot, entry)
    const packageInfo = yield* fileSystem.stat(packageDirectory)
    if (packageInfo.type !== "Directory") continue
    const manifestPath = path.join(packageDirectory, "package.json")
    if (!(yield* fileSystem.exists(manifestPath))) continue
    const manifest = yield* decodeJson(
      yield* fileSystem.readFileString(manifestPath),
      path.relative(packagesRoot, manifestPath)
    )
    const sourceConfigs = []
    for (const configPath of yield* findTsconfigs(packageDirectory)) {
      const inspected = yield* inspectTsconfig(configPath, path.dirname(configPath)).pipe(
        Effect.mapError(
          (error) =>
            new EffectTsconfigCoverageError({
              cause: error,
              reason: `${path.relative(packageDirectory, configPath)}: ${error.message}`
            })
        )
      )
      if (inspected !== undefined) {
        sourceConfigs.push({
          ...inspected,
          path: path.relative(packageDirectory, configPath)
        })
      }
    }
    records.push({
      checkCoversRoot: checkCoversRootTsconfig(manifest.scripts?.check),
      effectPackage: declaresEffect(manifest),
      name: manifest.name ?? `packages/${entry}`,
      sourceConfigs
    })
  }

  return records
})

const program = Effect.gen(function* () {
  yield* Effect.try({
    try: runSelfTest,
    catch: (cause) => new EffectTsconfigCoverageError({ cause, reason: "Effect tsconfig self-test failed" })
  })

  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  if (args.includes("--self-test")) return

  const path = yield* Path.Path
  const scriptPath = yield* path.fromFileUrl(new URL(import.meta.url))
  const repositoryRoot = path.dirname(path.dirname(scriptPath))
  const records = yield* inspectWorkspace(path.join(repositoryRoot, "packages"))
  const diagnostics = validatePackageRecords(records)
  if (diagnostics.length > 0) {
    return yield* fail(`Effect TypeScript coverage failed:\n- ${diagnostics.join("\n- ")}`)
  }
  const effectPackages = records.filter(({ effectPackage }) => effectPackage)
  const configCount = effectPackages.reduce((total, { sourceConfigs }) => total + sourceConfigs.length, 0)
  yield* Console.log(
    `Effect TypeScript coverage checked ${configCount} source configs across ${effectPackages.length} packages`
  )
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
