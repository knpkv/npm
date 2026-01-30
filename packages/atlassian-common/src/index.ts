/**
 * Shared utilities for Atlassian tools.
 *
 * @module
 */

// AST types
export * from "./ast/index.js"

// Brand utilities
export {
  ContentHash,
  IssueKey,
  makeBrandedNonEmptyString,
  makeBrandedString,
  PageId,
  ProjectKey,
  SpaceKey
} from "./Brand.js"

// Hash utilities
export { hashBuffer, hashContent, hashContentSync, hashEquals } from "./Hash.js"

// Error types
export { ParseError, SerializeError } from "./SerializeError.js"

// Serializers
export { serializeInlineNodes, type SerializeOptions, serializeToMarkdown } from "./serializers/index.js"

// Config utilities
export * from "./config/index.js"

// Auth utilities
export * from "./auth/index.js"
