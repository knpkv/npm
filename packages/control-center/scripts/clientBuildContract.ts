import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

// Includes the tiny module-preload index entry for the lazily split agent API contract.
export const CONTROL_CENTER_INITIAL_JAVASCRIPT_BUDGET_BYTES = 365_100

export const CONTROL_CENTER_BROWSER_SESSION_HYDRATOR_ENTRY = "src/client/BrowserSessionHydrator.tsx"

const CONTROL_CENTER_CLIENT_ENTRY = "index.html"
const CONTROL_CENTER_GENERATED_CLIENT_CHUNK_NAME = "client"

const ClientBuildManifestEntrySchema = Schema.Struct({
  dynamicImports: Schema.optionalKey(Schema.Array(Schema.String)),
  file: Schema.String,
  imports: Schema.optionalKey(Schema.Array(Schema.String)),
  isDynamicEntry: Schema.optionalKey(Schema.Boolean),
  isEntry: Schema.optionalKey(Schema.Boolean),
  name: Schema.optionalKey(Schema.String)
})

const ClientBuildManifestSchema = Schema.Record(Schema.String, ClientBuildManifestEntrySchema)

/** One Vite manifest entry relevant to JavaScript reachability. */
export interface ClientBuildManifestEntry {
  readonly dynamicImports?: ReadonlyArray<string>
  readonly file: string
  readonly imports?: ReadonlyArray<string>
  readonly isDynamicEntry?: boolean
  readonly isEntry?: boolean
  readonly name?: string
}

/** The decoded Vite client manifest keyed by source or generated chunk identifier. */
export type ClientBuildManifest = Readonly<Record<string, ClientBuildManifestEntry>>

interface InitialJavaScriptClosure {
  readonly artifactFiles: ReadonlyArray<string>
  readonly manifestKeys: ReadonlySet<string>
  readonly missingManifestKeys: ReadonlyArray<string>
}

const isJavaScriptArtifact = (file: string): boolean => file.endsWith(".js") || file.endsWith(".mjs")

const hasUnsafePathSegment = (file: string): boolean =>
  file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file) || file.split(/[\\/]/).includes("..")

const initialJavaScriptClosure = (manifest: ClientBuildManifest): InitialJavaScriptClosure => {
  const artifactFiles = new Set<string>()
  const manifestKeys = new Set<string>()
  const missingManifestKeys = new Set<string>()
  const pending = [CONTROL_CENTER_CLIENT_ENTRY]

  while (pending.length > 0) {
    const key = pending.pop()
    if (key === undefined || manifestKeys.has(key)) continue
    manifestKeys.add(key)
    const entry = manifest[key]
    if (entry === undefined) {
      missingManifestKeys.add(key)
      continue
    }
    if (isJavaScriptArtifact(entry.file)) artifactFiles.add(entry.file)
    for (const importedKey of entry.imports ?? []) pending.push(importedKey)
  }

  return {
    artifactFiles: [...artifactFiles].sort(),
    manifestKeys,
    missingManifestKeys: [...missingManifestKeys].sort()
  }
}

/** Decode untrusted Vite manifest JSON before applying distribution checks. */
export const decodeClientBuildManifest = (value: unknown): ClientBuildManifest | undefined => {
  const decoded = Schema.decodeUnknownResult(ClientBuildManifestSchema)(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

/** List the JavaScript artifacts fetched before any dynamic import is followed. */
export const initialJavaScriptArtifacts = (manifest: ClientBuildManifest): ReadonlyArray<string> =>
  initialJavaScriptClosure(manifest).artifactFiles

/** Return initial-payload and lazy-session boundary violations for a built client. */
export const inspectClientBuildContract = (
  manifest: ClientBuildManifest,
  artifactSizes: ReadonlyMap<string, number>
): ReadonlyArray<string> => {
  const violations: Array<string> = []
  const closure = initialJavaScriptClosure(manifest)
  const clientEntry = manifest[CONTROL_CENTER_CLIENT_ENTRY]

  for (const missingKey of closure.missingManifestKeys) {
    violations.push(`initial JavaScript closure references missing manifest entry ${JSON.stringify(missingKey)}`)
  }

  let initialBytes = 0
  for (const file of closure.artifactFiles) {
    if (hasUnsafePathSegment(file)) {
      violations.push(`initial JavaScript artifact has an unsafe path: ${JSON.stringify(file)}`)
      continue
    }
    const size = artifactSizes.get(file)
    if (size === undefined) {
      violations.push(`initial JavaScript artifact is missing from dist: ${JSON.stringify(file)}`)
      continue
    }
    initialBytes += size
  }
  if (initialBytes > CONTROL_CENTER_INITIAL_JAVASCRIPT_BUDGET_BYTES) {
    violations.push(
      `initial JavaScript closure is ${initialBytes} bytes; budget is ${CONTROL_CENTER_INITIAL_JAVASCRIPT_BUDGET_BYTES} bytes`
    )
  }

  const hydrator = manifest[CONTROL_CENTER_BROWSER_SESSION_HYDRATOR_ENTRY]
  if (hydrator === undefined) {
    violations.push("client manifest is missing BrowserSessionHydrator")
  } else {
    if (hydrator.isDynamicEntry !== true) violations.push("BrowserSessionHydrator must remain a dynamic entry")
    if (clientEntry?.dynamicImports?.includes(CONTROL_CENTER_BROWSER_SESSION_HYDRATOR_ENTRY) !== true) {
      violations.push("index.html must dynamically import BrowserSessionHydrator")
    }
    if (closure.manifestKeys.has(CONTROL_CENTER_BROWSER_SESSION_HYDRATOR_ENTRY)) {
      violations.push("BrowserSessionHydrator must remain outside the initial JavaScript closure")
    }
  }

  const generatedClientChunks = Object.entries(manifest).filter(
    ([, entry]) => entry.name === CONTROL_CENTER_GENERATED_CLIENT_CHUNK_NAME && isJavaScriptArtifact(entry.file)
  )
  if (generatedClientChunks.length !== 1) {
    violations.push("client manifest must contain exactly one generated API client chunk")
  } else {
    const generatedClientKey = generatedClientChunks[0]?.[0]
    if (generatedClientKey !== undefined) {
      if (closure.manifestKeys.has(generatedClientKey)) {
        violations.push("generated API client chunk must remain outside the initial JavaScript closure")
      }
      if (hydrator?.imports?.includes(generatedClientKey) !== true) {
        violations.push("BrowserSessionHydrator must import the generated API client chunk")
      }
    }
  }

  return violations
}
