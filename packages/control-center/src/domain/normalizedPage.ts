import * as Schema from "effect/Schema"

import { UtcTimestamp } from "./utcTimestamp.js"

const boundedText = (maximum: number, identifier: string) =>
  Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(maximum)).annotate({ identifier })

/** Safely converted document content. Raw provider markup and media are never retained here. */
export const NormalizedPageContent = Schema.Struct({
  representation: Schema.Literal("safe-markdown"),
  markdown: Schema.String.check(Schema.isMaxLength(262_144))
})

/** One immutable revision in the bounded page history. */
export const NormalizedPageVersion = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  createdAt: UtcTimestamp,
  message: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
  minorEdit: Schema.Boolean,
  authorSourcePersonId: Schema.NullOr(boundedText(512, "PageVersionAuthorSourcePersonId"))
})

/** One provider identity associated with a page and its document role. */
export const NormalizedPageContributor = Schema.Struct({
  sourcePersonId: boundedText(512, "PageContributorSourcePersonId"),
  displayName: boundedText(200, "PageContributorDisplayName"),
  active: Schema.Boolean,
  external: Schema.Boolean,
  resolved: Schema.Boolean,
  roles: Schema.Array(Schema.Literals(["owner", "author", "contributor", "watcher"])).check(
    Schema.isNonEmpty(),
    Schema.isUnique()
  )
})

/** Attachment metadata only. Bytes remain behind the authenticated provider boundary. */
export const NormalizedPageAttachment = Schema.Struct({
  id: boundedText(512, "PageAttachmentId"),
  title: boundedText(500, "PageAttachmentTitle"),
  createdAt: UtcTimestamp,
  mediaType: Schema.NullOr(Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(255))),
  fileSize: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  version: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0)))
})

const BoundedInventory = Schema.Struct({
  complete: Schema.Boolean,
  pagesFetched: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 }))
})

/** Optional rich document fields added to the provider-neutral page projection. */
export const NormalizedPageAttributes = Schema.Struct({
  sourceSpaceId: Schema.optionalKey(boundedText(512, "PageSourceSpaceId")),
  parentSourceId: Schema.optionalKey(Schema.NullOr(boundedText(512, "PageParentSourceId"))),
  createdAt: Schema.optionalKey(UtcTimestamp),
  updatedAt: Schema.optionalKey(UtcTimestamp),
  content: Schema.optionalKey(Schema.NullOr(NormalizedPageContent)),
  contentState: Schema.optionalKey(Schema.Literals(["loaded", "lazy"])),
  versions: Schema.optionalKey(Schema.Array(NormalizedPageVersion).check(Schema.isMaxLength(500))),
  versionHistory: Schema.optionalKey(BoundedInventory),
  contributors: Schema.optionalKey(Schema.Array(NormalizedPageContributor).check(Schema.isMaxLength(502))),
  attachments: Schema.optionalKey(Schema.Array(NormalizedPageAttachment).check(Schema.isMaxLength(50))),
  attachmentInventory: Schema.optionalKey(BoundedInventory),
  watcherInventory: Schema.optionalKey(BoundedInventory)
})

/** Decoded provider-neutral rich page fields. */
export type NormalizedPageAttributes = typeof NormalizedPageAttributes.Type
