/**
 * Runtime schemas for Jira Markdown Sync local workspace files.
 *
 * @internal
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { FIELD_SHAPES } from "./types.js"

const SiteUrl = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^https:\/\/[a-z0-9][a-z0-9-]*\.atlassian\.net$/))
)

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isMinLength(1)))

export const FieldShapeSchema = Schema.Literals(FIELD_SHAPES)

export const RequestedCustomFieldSchema = Schema.Struct({
  displayName: NonEmptyString,
  fieldId: Schema.optional(NonEmptyString),
  shape: FieldShapeSchema,
  ordered: Schema.optional(Schema.Boolean)
})

export const WorkspaceConfigSchema = Schema.Struct({
  version: Schema.Literal(1).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(1 as const))),
  siteUrl: SiteUrl,
  documentsDir: NonEmptyString.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed("issues"))),
  customFields: Schema.Array(RequestedCustomFieldSchema).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed([]))
  )
})

export const ManifestIssueSchema = Schema.Struct({
  issueId: NonEmptyString,
  issueKey: NonEmptyString,
  documentPath: NonEmptyString,
  filenameMode: Schema.Literals(["convention", "custom"] as const)
})

export const SyncManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  siteUrl: SiteUrl,
  issues: Schema.Array(ManifestIssueSchema)
})

const UserFieldValueSchema = Schema.Struct({
  accountId: NonEmptyString,
  displayName: NonEmptyString
})

const OptionFieldValueSchema = Schema.Struct({
  id: Schema.optional(NonEmptyString),
  value: NonEmptyString
})

const CascadingFieldValueSchema = Schema.Struct({
  parent: OptionFieldValueSchema,
  child: Schema.optional(OptionFieldValueSchema)
})

const SyncFieldValueItemSchema = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  UserFieldValueSchema,
  OptionFieldValueSchema
])

export const SyncFieldValueSchema = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
  UserFieldValueSchema,
  OptionFieldValueSchema,
  CascadingFieldValueSchema,
  Schema.Array(SyncFieldValueItemSchema)
])

export const BaselineCustomFieldSchema = Schema.Struct({
  fieldId: NonEmptyString,
  displayName: NonEmptyString,
  shape: FieldShapeSchema,
  value: SyncFieldValueSchema
})

export const SyncBaselineSchema = Schema.Struct({
  version: Schema.Literal(1),
  issueId: NonEmptyString,
  issueKey: NonEmptyString,
  fields: Schema.Struct({
    summary: Schema.String,
    description: Schema.String,
    labels: Schema.Array(Schema.String),
    customFields: Schema.Record(Schema.String, BaselineCustomFieldSchema)
  }),
  comments: Schema.Array(Schema.Struct({ id: NonEmptyString }))
})

export type WorkspaceConfig = Schema.Schema.Type<typeof WorkspaceConfigSchema>
export type SyncManifest = Schema.Schema.Type<typeof SyncManifestSchema>
export type SyncBaseline = Schema.Schema.Type<typeof SyncBaselineSchema>
