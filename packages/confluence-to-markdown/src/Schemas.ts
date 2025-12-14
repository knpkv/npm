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
  /** Local docs path (default: .confluence/docs) */
  docsPath: Schema.optionalWith(Schema.String, { default: () => ".confluence/docs" }),
  /** Glob patterns to exclude from sync */
  excludePatterns: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  /** Save original Confluence HTML alongside markdown (default: false) */
  saveSource: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  /** Glob patterns for files to track in git */
  trackedPaths: Schema.optionalWith(Schema.Array(Schema.String), { default: () => ["**/*.md"] })
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
  contentHash: ContentHashSchema,
  /** Version message from Confluence (used as git commit message) */
  versionMessage: Schema.optional(Schema.String),
  /** Author display name */
  authorName: Schema.optional(Schema.String),
  /** Author email */
  authorEmail: Schema.optional(Schema.String)
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
  spaceId: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  version: Schema.Struct({
    number: Schema.Number,
    createdAt: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
    authorId: Schema.optional(Schema.String)
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
    createdAt: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
    authorId: Schema.optional(Schema.String)
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

/**
 * Schema for OAuth user info.
 *
 * @category Schema
 */
export const OAuthUserSchema = Schema.Struct({
  /** Atlassian account ID */
  account_id: Schema.String,
  /** Display name (may be empty) */
  name: Schema.optional(Schema.String),
  /** Email address */
  email: Schema.String
})

/**
 * Type for OAuth user info.
 *
 * @category Types
 */
export type OAuthUser = Schema.Schema.Type<typeof OAuthUserSchema>

/**
 * Schema for stored OAuth token.
 *
 * @example
 * ```typescript
 * import { OAuthTokenSchema } from "@knpkv/confluence-to-markdown/Schemas"
 * import * as Schema from "effect/Schema"
 *
 * const token = Schema.decodeUnknownSync(OAuthTokenSchema)({
 *   access_token: "eyJ...",
 *   refresh_token: "eyJ...",
 *   expires_at: Date.now() + 3600000,
 *   scope: "read:confluence-content.all",
 *   cloud_id: "abc123",
 *   site_url: "https://mysite.atlassian.net"
 * })
 * ```
 *
 * @category Schema
 */
export const OAuthTokenSchema = Schema.Struct({
  /** OAuth access token */
  access_token: Schema.String,
  /** OAuth refresh token */
  refresh_token: Schema.String,
  /** Token expiration timestamp (Unix ms) */
  expires_at: Schema.Number,
  /** Granted scopes */
  scope: Schema.String,
  /** Atlassian Cloud site ID */
  cloud_id: Schema.String,
  /** Confluence site URL */
  site_url: Schema.String,
  /** Cached user info */
  user: Schema.optional(OAuthUserSchema)
})

/**
 * Type for stored OAuth token.
 *
 * @category Types
 */
export type OAuthToken = Schema.Schema.Type<typeof OAuthTokenSchema>

/**
 * Schema for OAuth client configuration.
 *
 * @category Schema
 */
export const OAuthConfigSchema = Schema.Struct({
  /** OAuth client ID from Atlassian Developer Console */
  clientId: Schema.String,
  /** OAuth client secret */
  clientSecret: Schema.String
})

/**
 * Type for OAuth client configuration.
 *
 * @category Types
 */
export type OAuthConfig = Schema.Schema.Type<typeof OAuthConfigSchema>

/**
 * Schema for Atlassian user info.
 *
 * @category Schema
 */
export const AtlassianUserSchema = Schema.Struct({
  /** Atlassian account ID */
  accountId: Schema.String,
  /** Display name */
  displayName: Schema.String,
  /** Email address (may be empty for privacy settings) */
  email: Schema.optional(Schema.String),
  /** Public name */
  publicName: Schema.optional(Schema.String)
})

/**
 * Type for Atlassian user info.
 *
 * @category Types
 */
export type AtlassianUser = Schema.Schema.Type<typeof AtlassianUserSchema>

/**
 * Schema for page version info (from versions list).
 *
 * @category Schema
 */
export const PageVersionSchema = Schema.Struct({
  /** Version number */
  number: Schema.Number,
  /** Author account ID */
  authorId: Schema.optional(Schema.String),
  /** Creation timestamp */
  createdAt: Schema.String,
  /** Version message/comment */
  message: Schema.optional(Schema.String),
  /** Page info with title and body (when body-format is requested) */
  page: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      title: Schema.optional(Schema.String),
      body: Schema.optional(
        Schema.Struct({
          storage: Schema.optional(
            Schema.Struct({
              value: Schema.String,
              representation: Schema.optional(Schema.String)
            })
          )
        })
      )
    })
  )
})

/**
 * Type for page version info.
 *
 * @category Types
 */
export type PageVersion = Schema.Schema.Type<typeof PageVersionSchema>

/**
 * Schema for page version with content.
 *
 * @category Schema
 */
export const PageVersionContentSchema = Schema.Struct({
  /** Version number */
  number: Schema.Number,
  /** Author account ID */
  authorId: Schema.optional(Schema.String),
  /** Creation timestamp */
  createdAt: Schema.String,
  /** Version message/comment */
  message: Schema.optional(Schema.String),
  /** Page content */
  body: Schema.optional(
    Schema.Struct({
      storage: Schema.optional(
        Schema.Struct({
          value: Schema.String,
          representation: Schema.optional(Schema.String)
        })
      )
    })
  )
})

/**
 * Type for page version with content.
 *
 * @category Types
 */
export type PageVersionContent = Schema.Schema.Type<typeof PageVersionContentSchema>

/**
 * Schema for page versions API response.
 *
 * @category Schema
 */
export const PageVersionsResponseSchema = Schema.Struct({
  results: Schema.Array(PageVersionSchema),
  _links: Schema.optional(
    Schema.Struct({
      next: Schema.optional(Schema.String)
    })
  )
})

/**
 * Type for page versions response.
 *
 * @category Types
 */
export type PageVersionsResponse = Schema.Schema.Type<typeof PageVersionsResponseSchema>

/**
 * Schema for Confluence space.
 *
 * @category Schema
 */
export const SpaceSchema = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  name: Schema.String,
  type: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  homepageId: Schema.optional(Schema.String),
  _links: Schema.optional(
    Schema.Struct({
      webui: Schema.optional(Schema.String)
    })
  )
})

/**
 * Type for Confluence space.
 *
 * @category Types
 */
export type Space = Schema.Schema.Type<typeof SpaceSchema>

/**
 * Schema for spaces API response.
 *
 * @category Schema
 */
export const SpacesResponseSchema = Schema.Struct({
  results: Schema.Array(SpaceSchema),
  _links: Schema.optional(
    Schema.Struct({
      next: Schema.optional(Schema.String)
    })
  )
})

/**
 * Type for spaces response.
 *
 * @category Types
 */
export type SpacesResponse = Schema.Schema.Type<typeof SpacesResponseSchema>
