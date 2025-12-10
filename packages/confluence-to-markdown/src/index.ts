/**
 * @knpkv/confluence-to-markdown
 *
 * Sync Confluence Cloud pages to local GitHub Flavored Markdown files.
 *
 * @packageDocumentation
 */

export * from "./Brand.js"
export { ConfluenceAuth, type ConfluenceAuthService, layer as ConfluenceAuthLayer } from "./ConfluenceAuth.js"
export {
  ConfluenceClient,
  type ConfluenceClientConfig,
  type CreatePageRequest,
  layer as ConfluenceClientLayer,
  type UpdatePageRequest
} from "./ConfluenceClient.js"
export {
  ConfluenceConfig,
  createConfigFile,
  layer as ConfluenceConfigLayer,
  layerFromValues as ConfluenceConfigLayerFromValues
} from "./ConfluenceConfig.js"
export * from "./ConfluenceError.js"
export { layer as LocalFileSystemLayer, type LocalFile, LocalFileSystem } from "./LocalFileSystem.js"
export { layer as MarkdownConverterLayer, MarkdownConverter } from "./MarkdownConverter.js"
export * from "./Schemas.js"
export {
  layer as SyncEngineLayer,
  type ProgressCallback,
  type PullOptions,
  type PullResult,
  type PushResult,
  type StatusResult,
  SyncEngine,
  type SyncStatus
} from "./SyncEngine.js"

// AST types
export * from "./ast/index.js"

// Parsers
export { parseConfluenceHtml } from "./parsers/ConfluenceParser.js"
export { parseMarkdown } from "./parsers/MarkdownParser.js"

// Serializers
export { serializeToConfluence } from "./serializers/ConfluenceSerializer.js"
export { serializeToMarkdown } from "./serializers/MarkdownSerializer.js"

// Bi-directional schemas
export { DocumentFromConfluence } from "./schemas/ConfluenceSchema.js"
export { DocumentFromMarkdown } from "./schemas/MarkdownSchema.js"

// Schema converter errors
export { MigrationError, ParseError, SerializeError } from "./SchemaConverterError.js"
