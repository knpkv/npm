import type { CreatePluginConnectionValue, PluginServiceCatalogEntry } from "../../api/plugins.js"

/** One provider adapter connection assembled by a setup workflow. */
export interface ServiceConnectionDraft {
  readonly catalog: PluginServiceCatalogEntry
  readonly displayName: string
  readonly values: ReadonlyArray<CreatePluginConnectionValue>
}

/** Convert one browser field value into the catalog-declared setup variant. */
export const serviceSetupValue = (
  field: PluginServiceCatalogEntry["configurationFields"][number],
  value: string
): CreatePluginConnectionValue => {
  switch (field.kind) {
    case "integer":
      return { _tag: "integer", key: field.key, value: Number(value) }
    case "secret":
      return { _tag: "secret", key: field.key, value }
    case "text":
    case "url":
      return { _tag: field.kind, key: field.key, value }
  }
}

/** Build a complete setup value list from catalog defaults and explicit overrides. */
export const serviceSetupValues = (
  catalog: PluginServiceCatalogEntry,
  overrides: ReadonlyMap<string, string>
): ReadonlyArray<CreatePluginConnectionValue> =>
  catalog.configurationFields.flatMap((field) => {
    const value = overrides.get(field.key) ?? field.defaultValue
    return value === null && !field.required ? [] : [serviceSetupValue(field, value ?? "")]
  })
