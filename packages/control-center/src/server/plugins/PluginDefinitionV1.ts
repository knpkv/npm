const PluginDefinitionTypeId: unique symbol = Symbol.for(
  "@knpkv/control-center/PluginDefinitionV1"
)

/**
 * Opaque version-one plugin definition. Executable factories and authority
 * services are deliberately absent from this import-clean public shape.
 */
export interface PluginDefinitionV1 {
  readonly [PluginDefinitionTypeId]: typeof PluginDefinitionTypeId
  readonly rawDescriptor: unknown
}

/** Construct the opaque identity inside server-only plugin composition. @internal */
export const makePluginDefinitionV1 = (rawDescriptor: unknown): PluginDefinitionV1 => ({
  [PluginDefinitionTypeId]: PluginDefinitionTypeId,
  rawDescriptor
})
