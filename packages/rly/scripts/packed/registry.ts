import { validateComponentsRegistry } from "../registry/registry-validation.js"

/** Registry files that must survive npm packing as explicit package exports. */
export const PACKED_REGISTRY_ARTIFACTS: ReadonlyArray<string> = [
  "package/registry/components.json",
  "package/registry/schema.json",
  "package/registry/search.json",
  "package/registry/USAGE.md"
]

const parseJson = (source: string, label: string): { readonly error?: string; readonly value?: unknown } => {
  try {
    return { value: JSON.parse(source) }
  } catch {
    return { error: `Packed ${label} is not valid JSON` }
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null

const readNames = (value: unknown, property: string): ReadonlyArray<string> | undefined => {
  if (!isRecord(value)) return undefined
  const records = value[property]
  if (!Array.isArray(records)) return undefined
  const unknownRecords: ReadonlyArray<unknown> = records
  const names: Array<string> = []
  for (const record of unknownRecords) {
    if (!isRecord(record) || typeof record.name !== "string") return undefined
    names.push(record.name)
  }
  return names
}

/** Validate the packed registry without importing source-only manifest code. */
export const validatePackedRegistry = (input: {
  readonly components: string
  readonly schema: string
  readonly search: string
  readonly usage: string
}): string | undefined => {
  const componentsResult = parseJson(input.components, "components registry")
  if (componentsResult.error !== undefined) return componentsResult.error
  const schemaResult = parseJson(input.schema, "registry schema")
  if (schemaResult.error !== undefined) return schemaResult.error
  const searchResult = parseJson(input.search, "registry search index")
  if (searchResult.error !== undefined) return searchResult.error

  const schemaFailures = validateComponentsRegistry(schemaResult.value, componentsResult.value)
  if (schemaFailures.length > 0) return `Packed components registry failed its schema: ${schemaFailures.join("; ")}`

  const componentNames = readNames(componentsResult.value, "components")
  const searchNames = readNames(searchResult.value, "records")
  if (componentNames === undefined || componentNames.length === 0) return "Packed components registry is empty"
  if (searchNames === undefined || searchNames.join("\n") !== componentNames.join("\n")) {
    return "Packed search index does not cover the exact component registry"
  }
  if (!input.usage.includes("no component implementation") || !input.usage.includes("JSON-to-React")) {
    return "Packed registry usage guide omits its non-executable boundary"
  }
  return undefined
}
