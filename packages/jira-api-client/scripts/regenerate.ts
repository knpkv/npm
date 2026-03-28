#!/usr/bin/env tsx
/**
 * Regeneration script for Jira API types.
 *
 * Fetches OpenAPI specs from Atlassian and regenerates openapi-typescript types.
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

const generateTypes = (specPath: string): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: async () => {
      const outputFile = path.join(GENERATED_DIR, "schema.d.ts")
      execSync(
        `pnpm exec openapi-typescript "${specPath}" -o "${outputFile}"`,
        { cwd: path.join(__dirname, "..") }
      )
    },
    catch: (e) => new Error(`Type generation failed: ${e}`)
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

    yield* Console.log("Generating types...")
    yield* generateTypes(specPath)
    yield* Console.log(`Generated: src/generated/v3/schema.d.ts`)

    yield* writeVersion(VERSION_V3_FILE, v3Info.version)
    yield* Console.log("Done!")
  })
).pipe(Command.withDescription("Regenerate Jira API types from OpenAPI specs"))

const cli = Command.run(regenerate, {
  name: pkg.name,
  version: pkg.version
})

Effect.suspend(() => cli(process.argv)).pipe(
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain
)
