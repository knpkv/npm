/** Schema-owned Confluence page normalization boundary. @module */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { hasMaximumPluginJsonBytes, MaximumPluginPayloadBytes } from "../../../domain/plugins/bounds.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"

const boundedString = (maximum: number) =>
  Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(maximum))
const timestampString = Schema.String.check(
  Schema.makeFilter(
    (value) => Result.isSuccess(Schema.decodeUnknownResult(UtcTimestamp)(value)),
    { expected: "an ISO-8601 UTC timestamp" }
  )
)

/** @internal */
export const RawConfluenceVersion = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  createdAt: timestampString,
  message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_000))),
  minorEdit: Schema.optionalKey(Schema.Boolean),
  authorId: Schema.optionalKey(boundedString(512))
})

/** Required subset of the current-page response, decoded again at the adapter boundary. @internal */
export const RawConfluencePage = Schema.Struct({
  id: boundedString(512),
  status: Schema.Literal("current"),
  title: boundedString(500),
  spaceId: boundedString(512),
  parentId: Schema.optionalKey(boundedString(512)),
  authorId: Schema.optionalKey(boundedString(512)),
  ownerId: Schema.optionalKey(Schema.NullOr(boundedString(512))),
  createdAt: timestampString,
  version: RawConfluenceVersion,
  body: Schema.optionalKey(Schema.Struct({
    atlas_doc_format: Schema.optionalKey(Schema.Struct({
      representation: Schema.optionalKey(Schema.Literal("atlas_doc_format")),
      value: Schema.String.check(Schema.isMaxLength(1_048_576))
    }))
  })),
  _links: Schema.optionalKey(Schema.Struct({
    webui: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_096)))
  }))
})

/** Decoded current Confluence page. @internal */
export type RawConfluencePage = typeof RawConfluencePage.Type

/** One bounded page of current pages from exactly one configured space. @internal */
export const RawConfluenceSpacePage = Schema.Struct({
  results: Schema.optionalKey(Schema.Array(RawConfluencePage).check(Schema.isMaxLength(25))),
  _links: Schema.optionalKey(Schema.Struct({
    next: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_096)))
  }))
})

/** Decoded current-page listing for one space. @internal */
export type RawConfluenceSpacePage = typeof RawConfluenceSpacePage.Type

/** Attachment metadata retained without loading attachment bytes. @internal */
export const RawConfluenceAttachment = Schema.Struct({
  id: boundedString(512),
  status: Schema.Literal("current"),
  title: boundedString(500),
  createdAt: timestampString,
  pageId: boundedString(512),
  mediaType: Schema.optionalKey(Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(255))),
  fileSize: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  version: Schema.optionalKey(Schema.Struct({
    number: Schema.Int.check(Schema.isGreaterThan(0))
  }))
})

/** One bounded attachment metadata page. @internal */
export const RawConfluenceAttachmentPage = Schema.Struct({
  results: Schema.optionalKey(Schema.Array(RawConfluenceAttachment).check(Schema.isMaxLength(25))),
  _links: Schema.optionalKey(Schema.Struct({
    next: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_096)))
  }))
})

/** Decoded attachment metadata page. @internal */
export type RawConfluenceAttachmentPage = typeof RawConfluenceAttachmentPage.Type

/** One bounded watcher page from the legacy page-notification read endpoint. @internal */
export const RawConfluenceWatcherPage = Schema.Struct({
  results: Schema.Array(Schema.Struct({
    type: boundedString(100),
    contentId: Schema.Int.check(Schema.isGreaterThan(0)),
    watcher: Schema.Struct({
      accountId: Schema.NullOr(boundedString(512))
    })
  })).check(Schema.isMaxLength(50)),
  start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
  size: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50 }))
})

/** Decoded page watcher metadata. @internal */
export type RawConfluenceWatcherPage = typeof RawConfluenceWatcherPage.Type

/** One decoded page of version history. @internal */
export const RawConfluenceVersionPage = Schema.Struct({
  results: Schema.optionalKey(Schema.Array(RawConfluenceVersion).check(Schema.isMaxLength(100))),
  _links: Schema.optionalKey(Schema.Struct({
    next: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_096)))
  }))
})

/** Decoded page of version history. @internal */
export type RawConfluenceVersionPage = typeof RawConfluenceVersionPage.Type

/** Decoded Confluence page version. @internal */
export type RawConfluenceVersion = typeof RawConfluenceVersion.Type

/** Privacy-limited profile returned by the current-user endpoint. @internal */
export const RawConfluenceCurrentUser = Schema.Struct({
  accountId: boundedString(512),
  displayName: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))),
  publicName: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200)))
})

/** Decoded current Confluence user. @internal */
export type RawConfluenceCurrentUser = typeof RawConfluenceCurrentUser.Type

/** Bounded Confluence user returned by current-user and bulk-user reads. @internal */
export const RawConfluenceUser = Schema.Struct({
  accountId: boundedString(512),
  displayName: Schema.optionalKey(Schema.NullOr(boundedString(200))),
  accountStatus: Schema.optionalKey(Schema.Literals(["active", "inactive", "closed", "unknown"])),
  isExternalCollaborator: Schema.optionalKey(Schema.Boolean)
})

/** Decoded result from one bounded bulk user lookup. @internal */
export const RawConfluenceUsers = Schema.Struct({
  results: Schema.optionalKey(Schema.Array(RawConfluenceUser).check(Schema.isMaxLength(250)))
})

/** Decoded Confluence user. @internal */
export type RawConfluenceUser = typeof RawConfluenceUser.Type

const NormalizedVersion = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  createdAt: timestampString,
  message: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
  minorEdit: Schema.Boolean,
  authorId: Schema.NullOr(boundedString(512))
})

const NormalizedContributor = Schema.Struct({
  accountId: boundedString(512),
  displayName: boundedString(200),
  active: Schema.Boolean,
  external: Schema.Boolean,
  resolved: Schema.Boolean,
  roles: Schema.Array(Schema.Literals(["owner", "author", "contributor", "watcher"])).check(
    Schema.isNonEmpty(),
    Schema.isUnique()
  )
})

/** Versioned vendor-neutral payload stored on a normalized Confluence page entity. @internal */
export const ConfluencePageAttributesV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  status: Schema.Literal("current"),
  spaceId: boundedString(512),
  parentId: Schema.NullOr(boundedString(512)),
  createdAt: timestampString,
  updatedAt: timestampString,
  currentVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  content: Schema.NullOr(Schema.Struct({
    representation: Schema.Literal("safe-markdown"),
    markdown: Schema.String.check(Schema.isMaxLength(262_144))
  })),
  versions: Schema.Array(NormalizedVersion).check(Schema.isMaxLength(500)),
  versionHistory: Schema.Struct({
    complete: Schema.Boolean,
    pagesFetched: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))
  }),
  contributors: Schema.Array(NormalizedContributor).check(Schema.isMaxLength(502)),
  attachments: Schema.optionalKey(
    Schema.Array(Schema.Struct({
      id: boundedString(512),
      title: boundedString(500),
      createdAt: timestampString,
      mediaType: Schema.NullOr(Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(255))),
      fileSize: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      version: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0)))
    })).check(Schema.isMaxLength(50))
  ),
  attachmentInventory: Schema.optionalKey(Schema.Struct({
    complete: Schema.Boolean,
    pagesFetched: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 }))
  })),
  watcherInventory: Schema.optionalKey(Schema.Struct({
    complete: Schema.Boolean,
    pagesFetched: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 }))
  })),
  contentState: Schema.optionalKey(Schema.Literals(["loaded", "lazy"]))
}).check(hasMaximumPluginJsonBytes(MaximumPluginPayloadBytes))

/** Decoded normalized Confluence page attributes. @internal */
export type ConfluencePageAttributesV1 = typeof ConfluencePageAttributesV1.Type
