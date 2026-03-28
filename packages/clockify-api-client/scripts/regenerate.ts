#!/usr/bin/env tsx
/**
 * Regeneration script for Clockify API client.
 *
 * 1. Fetches latest OpenAPI spec from Clockify docs
 * 2. Applies local patches (.specs/clockify-v1.patch.json) to fix incomplete DTOs
 * 3. Generates TypeScript types via openapi-typescript
 */
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { execSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SPECS_DIR = path.join(__dirname, "..", ".specs")
const SPEC_FILE = path.join(SPECS_DIR, "clockify-v1.json")
const PATCH_FILE = path.join(SPECS_DIR, "clockify-v1.patch.json")
const OUTPUT_FILE = path.join(__dirname, "..", "src", "generated", "schema.d.ts")
const VERSION_FILE = path.join(SPECS_DIR, "VERSION")
const SPEC_URL = "https://docs.clockify.me/openapi.json"

interface SpecInfo {
  version: string
  title: string
}

const fetchSpecInfo = (): Effect.Effect<SpecInfo, Error> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(SPEC_URL)
      if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`)
      const spec = (await response.json()) as { info: { version: string; title: string } }
      return { version: spec.info.version, title: spec.info.title }
    },
    catch: (e) => new Error(`Fetch failed: ${e}`)
  })

const fetchAndSaveSpec = (): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(SPEC_URL)
      if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`)
      fs.writeFileSync(SPEC_FILE, await response.text(), "utf-8")
    },
    catch: (e) => new Error(`Fetch/save failed: ${e}`)
  })

/**
 * Apply patches from clockify-v1.patch.json to the spec in-place.
 * Keeps original spec clean — patches add missing fields and required arrays.
 */
const applyPatches = (): Effect.Effect<void, Error> =>
  Effect.try({
    try: () => {
      if (!fs.existsSync(PATCH_FILE)) return

      const spec = JSON.parse(fs.readFileSync(SPEC_FILE, "utf-8"))
      const patches = JSON.parse(fs.readFileSync(PATCH_FILE, "utf-8"))
      const schemas = spec.components?.schemas ?? {}

      for (const [schemaName, patch] of Object.entries(patches.schemas ?? {}) as Array<[string, Record<string, unknown>]>) {
        const schema = schemas[schemaName]
        if (!schema) continue

        // Rename properties (e.g. get_id → id)
        if (patch.renameProperties) {
          for (const [from, to] of Object.entries(patch.renameProperties as Record<string, string>)) {
            if (schema.properties?.[from]) {
              schema.properties[to] = schema.properties[from]
              delete schema.properties[from]
            }
          }
        }

        // Add new properties
        if (patch.addProperties) {
          schema.properties = { ...schema.properties, ...patch.addProperties }
        }

        // Patch existing properties (overwrite)
        if (patch.patchProperties) {
          for (const [name, value] of Object.entries(patch.patchProperties as Record<string, unknown>)) {
            schema.properties[name] = value
          }
        }

        // Set required fields
        if (patch.required) {
          schema.required = patch.required
        }
      }

      fs.writeFileSync(SPEC_FILE, JSON.stringify(spec, null, 2), "utf-8")
    },
    catch: (e) => new Error(`Patch failed: ${e}`)
  })

const generateTypes = (): Effect.Effect<void, Error> =>
  Effect.try({
    try: () => {
      execSync(`npx openapi-typescript "${SPEC_FILE}" -o "${OUTPUT_FILE}"`, {
        cwd: path.join(__dirname, ".."),
        stdio: "inherit"
      })
    },
    catch: (e) => new Error(`Generation failed: ${e}`)
  })

const program = Effect.gen(function*() {
  yield* Console.log("Fetching Clockify API spec version...")

  const info = yield* fetchSpecInfo()
  const current = fs.existsSync(VERSION_FILE) ? fs.readFileSync(VERSION_FILE, "utf-8").trim() : null

  yield* Console.log(`Current: ${current ?? "none"}, Remote: ${info.version}`)

  if (current === info.version) {
    yield* Console.log("Spec up to date, regenerating types...")
  } else {
    if (!fs.existsSync(SPECS_DIR)) fs.mkdirSync(SPECS_DIR, { recursive: true })

    yield* Console.log(`Fetching spec (${info.version})...`)
    yield* fetchAndSaveSpec()
    fs.writeFileSync(VERSION_FILE, info.version, "utf-8")
  }

  yield* Console.log("Applying patches...")
  yield* applyPatches()

  yield* Console.log("Generating types...")
  yield* generateTypes()

  yield* Console.log("Done.")
})

Effect.runPromise(program).catch(console.error)
