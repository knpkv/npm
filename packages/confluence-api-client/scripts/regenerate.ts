#!/usr/bin/env tsx
/**
 * Regeneration script for Confluence API clients.
 *
 * Fetches OpenAPI specs from Atlassian, compares versions, and regenerates clients if needed.
 */
import { Command, Options } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import pkg from "../package.json" with { type: "json" }

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SPECS_DIR = path.join(__dirname, "..", ".specs")
const VERSION_V1_FILE = path.join(SPECS_DIR, "VERSION_V1")
const VERSION_V2_FILE = path.join(SPECS_DIR, "VERSION_V2")

const SPEC_URLS = {
  v1: "https://dac-static.atlassian.com/cloud/confluence/swagger.v3.json",
  v2: "https://dac-static.atlassian.com/cloud/confluence/openapi-v2.v3.json"
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

const checkOnly = Options.boolean("check").pipe(
  Options.withDescription("Check only, exit 1 if outdated"),
  Options.withDefault(false)
)

const regenerate = Command.make("regenerate", { checkOnly }, ({ checkOnly }) =>
  Effect.gen(function*() {
    yield* Console.log("Fetching Confluence API spec versions...")

    const [v1Info, v2Info] = yield* Effect.all([
      fetchSpecInfo(SPEC_URLS.v1),
      fetchSpecInfo(SPEC_URLS.v2)
    ])

    const currentV1 = yield* readVersion(VERSION_V1_FILE)
    const currentV2 = yield* readVersion(VERSION_V2_FILE)

    yield* Console.log(`V1: current=${currentV1 ?? "none"}, remote=${v1Info.version}`)
    yield* Console.log(`V2: current=${currentV2 ?? "none"}, remote=${v2Info.version}`)

    const v1Changed = currentV1 !== v1Info.version
    const v2Changed = currentV2 !== v2Info.version

    if (!v1Changed && !v2Changed) {
      yield* Console.log("All specs up to date.")
      return
    }

    if (checkOnly) {
      yield* Console.log("Specs are outdated!")
      if (v1Changed) yield* Console.log(`  V1: ${currentV1} -> ${v1Info.version}`)
      if (v2Changed) yield* Console.log(`  V2: ${currentV2} -> ${v2Info.version}`)
      return yield* Effect.fail(new Error("Specs outdated"))
    }

    yield* ensureDir(SPECS_DIR)

    if (v1Changed) {
      yield* Console.log(`Fetching V1 spec (${v1Info.version})...`)
      const specPath = path.join(SPECS_DIR, `confluence-v1-${v1Info.version}.json`)
      yield* fetchAndSaveSpec(SPEC_URLS.v1, specPath)
      yield* writeVersion(VERSION_V1_FILE, v1Info.version)
      yield* Console.log(`Saved: ${specPath}`)
    }

    if (v2Changed) {
      yield* Console.log(`Fetching V2 spec (${v2Info.version})...`)
      const specPath = path.join(SPECS_DIR, `confluence-v2-${v2Info.version}.json`)
      yield* fetchAndSaveSpec(SPEC_URLS.v2, specPath)
      yield* writeVersion(VERSION_V2_FILE, v2Info.version)
      yield* Console.log(`Saved: ${specPath}`)
    }

    yield* Console.log("")
    yield* Console.log("NOTE: Manual client files in src/generated/ need manual updates.")
    yield* Console.log("The generated clients are minimal and hand-crafted due to OpenAPI spec complexity.")
    yield* Console.log("")
    yield* Console.log("Review the new specs and update the client files if needed:")
    yield* Console.log("  - src/generated/v1/Client.ts")
    yield* Console.log("  - src/generated/v2/Client.ts")
  })
).pipe(Command.withDescription("Regenerate Confluence API clients from OpenAPI specs"))

const cli = Command.run(regenerate, {
  name: pkg.name,
  version: pkg.version
})

Effect.suspend(() => cli(process.argv)).pipe(
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain
)
