/**
 * Schema definitions for configuration and data structures.
 *
 * @module
 */
import * as Schema from "effect/Schema"
import { ContentHashSchema, PageIdSchema, SpaceKeySchema } from "./Brand.js"

/**
 * Schema for .confluence.json configuration file.
 *
 * @example
 * ```typescript
 * import { ConfluenceConfigFileSchema } from "@knpkv/confluence-to-markdown/Schemas"
 * import * as Schema from "effect/Schema"
 *
 * const config = Schema.decodeUnknownSync(ConfluenceConfigFileSchema)({
 *   rootPageId: "12345",
 *   baseUrl: "https://mysite.atlassian.net"
 * })
 * ```
 *
 * @category Schema
 */
export const ConfluenceConfigFileSchema = Schema.Struct({
  /** Root page ID to sync from */
  rootPageId: PageIdSchema,
  /** Confluence Cloud base URL */
  baseUrl: Schema.String.pipe(
    Schema.pattern(/^https:\/\/[a-z0-9-]+\.atlassian\.net$/)
  ),
  /** Optional space key */
  spaceKey: Schema.optional(SpaceKeySchema),
  /** Local docs path (default: .docs/confluence) */
  docsPath: Schema.optionalWith(Schema.String, { default: () => ".docs/confluence" }),
  /** Glob patterns to exclude from sync */
  excludePatterns: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  /** Save original Confluence HTML alongside markdown (default: false) */
  saveSource: Schema.optionalWith(Schema.Boolean, { default: () => false })
})

/**
 * Type for .confluence.json configuration file.
 *
 * @category Types
 */
export type ConfluenceConfigFile = Schema.Schema.Type<typeof ConfluenceConfigFileSchema>

/**
 * Schema for page front-matter in markdown files.
 *
 * @example
 * ```typescript
 * import { PageFrontMatterSchema } from "@knpkv/confluence-to-markdown/Schemas"
 * import * as Schema from "effect/Schema"
 *
 * const frontMatter = Schema.decodeUnknownSync(PageFrontMatterSchema)({
 *   pageId: "12345",
 *   version: 3,
 *   title: "My Page",
 *   updated: "2025-01-15T10:30:00Z",
 *   contentHash: "a".repeat(64)
 * })
 * ```
 *
 * @category Schema
 */
export const PageFrontMatterSchema = Schema.Struct({
  /** Confluence page ID */
  pageId: PageIdSchema,
  /** Page version number */
  version: Schema.Number.pipe(Schema.int(), Schema.positive()),
  /** Page title */
  title: Schema.String.pipe(Schema.nonEmptyString()),
  /** Last updated timestamp (ISO8601) */
  updated: Schema.DateFromString,
  /** Parent page ID (optional) */
  parentId: Schema.optional(PageIdSchema),
  /** Position among siblings (optional) */
  position: Schema.optional(Schema.Number),
  /** SHA256 hash of content for change detection */
  contentHash: ContentHashSchema
})

/**
 * Type for page front-matter.
 *
 * @category Types
 */
export type PageFrontMatter = Schema.Schema.Type<typeof PageFrontMatterSchema>

/**
 * Schema for new page front-matter (no pageId yet).
 *
 * @category Schema
 */
export const NewPageFrontMatterSchema = Schema.Struct({
  /** Page title */
  title: Schema.String.pipe(Schema.nonEmptyString()),
  /** Parent page ID (optional, determined by directory structure) */
  parentId: Schema.optional(PageIdSchema)
})

/**
 * Type for new page front-matter.
 *
 * @category Types
 */
export type NewPageFrontMatter = Schema.Schema.Type<typeof NewPageFrontMatterSchema>

/**
 * Schema for sync state file (.sync-state.json).
 *
 * @category Schema
 */
export const SyncStateSchema = Schema.Struct({
  /** Last sync timestamp */
  lastSync: Schema.DateFromString,
  /** Map of page ID to sync info */
  pages: Schema.Record({
    key: Schema.String,
    value: Schema.Struct({
      /** Local file path */
      localPath: Schema.String,
      /** Last synced version */
      version: Schema.Number,
      /** Content hash at last sync */
      contentHash: ContentHashSchema
    })
  })
})

/**
 * Type for sync state.
 *
 * @category Types
 */
export type SyncState = Schema.Schema.Type<typeof SyncStateSchema>

/**
 * Schema for Confluence page API response (full, from getPage).
 *
 * @category Schema
 */
export const PageResponseSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.optional(Schema.String),
  version: Schema.Struct({
    number: Schema.Number,
    createdAt: Schema.optional(Schema.String)
  }),
  body: Schema.optional(
    Schema.Struct({
      storage: Schema.optional(
        Schema.Struct({
          value: Schema.String,
          representation: Schema.optional(Schema.String)
        })
      )
    })
  ),
  parentId: Schema.optional(Schema.String),
  position: Schema.optional(Schema.Number),
  _links: Schema.optional(
    Schema.Struct({
      webui: Schema.optional(Schema.String)
    })
  )
})

/**
 * Type for page API response.
 *
 * @category Types
 */
export type PageResponse = Schema.Schema.Type<typeof PageResponseSchema>

/**
 * Schema for page list item (children list, version optional).
 *
 * @category Schema
 */
export const PageListItemSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.optional(Schema.String),
  version: Schema.optional(Schema.Struct({
    number: Schema.Number,
    createdAt: Schema.optional(Schema.String)
  })),
  body: Schema.optional(
    Schema.Struct({
      storage: Schema.optional(
        Schema.Struct({
          value: Schema.String,
          representation: Schema.optional(Schema.String)
        })
      )
    })
  ),
  parentId: Schema.optional(Schema.String),
  position: Schema.optional(Schema.Number),
  _links: Schema.optional(
    Schema.Struct({
      webui: Schema.optional(Schema.String)
    })
  )
})

/**
 * Type for page list item.
 *
 * @category Types
 */
export type PageListItem = Schema.Schema.Type<typeof PageListItemSchema>

/**
 * Schema for page children API response.
 *
 * @category Schema
 */
export const PageChildrenResponseSchema = Schema.Struct({
  results: Schema.Array(PageListItemSchema),
  _links: Schema.optional(
    Schema.Struct({
      next: Schema.optional(Schema.String)
    })
  )
})

/**
 * Type for page children response.
 *
 * @category Types
 */
export type PageChildrenResponse = Schema.Schema.Type<typeof PageChildrenResponseSchema>
