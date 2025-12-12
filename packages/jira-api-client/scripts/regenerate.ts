#!/usr/bin/env tsx
/**
 * Regeneration script for Jira API clients.
 *
 * Fetches OpenAPI specs from Atlassian and regenerates Effect clients.
 */
import { Command, Options } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { execSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import pkg from "../package.json" with { type: "json" }

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SPECS_DIR = path.join(__dirname, "..", ".specs")
const VERSION_V3_FILE = path.join(SPECS_DIR, "VERSION_V3")
const GENERATED_DIR = path.join(__dirname, "..", "src", "generated", "v3")

const SPEC_URLS = {
  v3: "https://dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json"
} as const

interface SpecInfo {
  version: string
  title: string
}

const fetchSpecInfo = (url: string): Effect.Effect<SpecInfo, Error> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status}`)
      }
      const spec = await response.json() as { info: { version: string; title: string } }
      return { version: spec.info.version, title: spec.info.title }
    },
    catch: (e) => new Error(`Fetch failed: ${e}`)
  })

const fetchAndSaveSpec = (url: string, outputPath: string): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status}`)
      }
      const spec = await response.text()
      fs.writeFileSync(outputPath, spec, "utf-8")
    },
    catch: (e) => new Error(`Fetch/save failed: ${e}`)
  })

const readVersion = (file: string): Effect.Effect<string | null> =>
  Effect.sync(() => {
    try {
      return fs.readFileSync(file, "utf-8").trim()
    } catch {
      return null
    }
  })

const writeVersion = (file: string, version: string): Effect.Effect<void> =>
  Effect.sync(() => fs.writeFileSync(file, version, "utf-8"))

const ensureDir = (dir: string): Effect.Effect<void> =>
  Effect.sync(() => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  })

// Wrap all class references with S.suspend to handle forward/circular references
const fixCircularRefs = (content: string): string => {
  let fixed = content

  // First, collect all class names defined in the file
  const classNames = new Set<string>()
  const classPattern = /export class (\w+) extends S\.(Class|Struct|Literal|Record|Array)/g
  let match
  while ((match = classPattern.exec(content)) !== null) {
    classNames.add(match[1])
  }

  // Wrap references to these classes with S.suspend
  for (const className of classNames) {
    // Skip S.* built-in types
    if (className.startsWith("S.")) continue

    // Replace direct references in optionalWith with S.suspend
    const optPattern = new RegExp(`S\\.optionalWith\\(${className},`, "g")
    fixed = fixed.replace(optPattern, `S.optionalWith(S.suspend(() => ${className}),`)

    // Replace direct references in Array with S.suspend
    const arrayPattern = new RegExp(`S\\.Array\\(${className}\\)`, "g")
    fixed = fixed.replace(arrayPattern, `S.Array(S.suspend(() => ${className}))`)

    // Replace direct references in allOf/Record/etc with S.suspend
    const directPattern = new RegExp(`\\(${className}\\)(?!\\s*=>)`, "g")
    fixed = fixed.replace(directPattern, `(S.suspend(() => ${className}))`)
  }

  return fixed
}

const fixSelfReferentialClasses = (content: string): string => {
  let fixed = content
  // Fix "class Foo extends Foo {}" -> "class Foo extends S.Struct({}) {}"
  fixed = fixed.replace(
    /export class (\w+) extends \1 \{\}/g,
    "export class $1 extends S.Struct({}) {}"
  )
  // Fix broken "extends {" syntax (openapi-gen bug for empty request bodies)
  fixed = fixed.replace(
    /export class (\w+) extends \{\s*\} \{\}/g,
    "export class $1 extends S.Struct({}) {}"
  )
  return fixed
}

const fixDuplicateProperties = (content: string): string => {
  // Remove "toString" property which conflicts with built-in Object.prototype.toString
  // Pattern handles both mid-struct (with trailing comma) and end-of-struct (no comma)
  let fixed = content
  // Remove toString with preceding JSDoc comment (handles end-of-struct case)
  // JSDoc: /**...*/ then newline then "toString": S.optionalWith(...)
  fixed = fixed.replace(/,\n\s*\/\*\*[\s\S]*?\*\/\n"toString": S\.optionalWith\(S\.String,\s*\{\s*nullable:\s*true\s*\}\)/g, "")
  // Remove toString with trailing comma (mid-struct case)
  fixed = fixed.replace(/\s*\/\*\*[\s\S]*?\*\/\n"toString": S\.optionalWith\(S\.String,\s*\{\s*nullable:\s*true\s*\}\),\n/g, "")
  return fixed
}


const generateClient = (specPath: string): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: async () => {
      const outputFile = path.join(GENERATED_DIR, "Client.ts")
      execSync(
        `pnpm --silent openapi-gen --spec "${specPath}" --name "JiraV3Client" > "${outputFile}"`,
        { cwd: path.join(__dirname, "..") }
      )

      let content = fs.readFileSync(outputFile, "utf-8")

      // Fix circular/forward references with S.suspend
      content = fixCircularRefs(content)

      // Fix self-referential classes (openapi-gen bug)
      content = fixSelfReferentialClasses(content)

      // Fix duplicate properties like "toString"
      content = fixDuplicateProperties(content)

      // Prepend headers
      content = `// @ts-nocheck\n/* eslint-disable */\n/**\n * Auto-generated by @tim-smart/openapi-gen\n * DO NOT EDIT - changes will be overwritten\n */\n${content}`
      fs.writeFileSync(outputFile, content, "utf-8")
    },
    catch: (e) => new Error(`Code generation failed: ${e}`)
  })

const checkOnly = Options.boolean("check").pipe(
  Options.withDescription("Check only, exit 1 if outdated"),
  Options.withDefault(false)
)

const regenerate = Command.make("regenerate", { checkOnly }, ({ checkOnly }) =>
  Effect.gen(function*() {
    yield* Console.log("Fetching Jira API spec version...")

    const v3Info = yield* fetchSpecInfo(SPEC_URLS.v3)
    const currentV3 = yield* readVersion(VERSION_V3_FILE)

    yield* Console.log(`V3: current=${currentV3 ?? "none"}, remote=${v3Info.version}`)

    const v3Changed = currentV3 !== v3Info.version

    if (!v3Changed) {
      yield* Console.log("Spec is up to date.")
      return
    }

    if (checkOnly) {
      yield* Console.log("Spec is outdated!")
      yield* Console.log(`  V3: ${currentV3} -> ${v3Info.version}`)
      return yield* Effect.fail(new Error("Spec outdated"))
    }

    yield* ensureDir(SPECS_DIR)
    yield* ensureDir(GENERATED_DIR)

    const specPath = path.join(SPECS_DIR, `jira-v3-${v3Info.version}.json`)

    yield* Console.log(`Fetching V3 spec (${v3Info.version})...`)
    yield* fetchAndSaveSpec(SPEC_URLS.v3, specPath)
    yield* Console.log(`Saved: ${specPath}`)

    yield* Console.log("Generating Effect client...")
    yield* generateClient(specPath)
    yield* Console.log(`Generated: src/generated/v3/Client.ts`)

    yield* writeVersion(VERSION_V3_FILE, v3Info.version)
    yield* Console.log("Done!")
  })
).pipe(Command.withDescription("Regenerate Jira API clients from OpenAPI specs"))

const cli = Command.run(regenerate, {
  name: pkg.name,
  version: pkg.version
})

Effect.suspend(() => cli(process.argv)).pipe(
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain
)
