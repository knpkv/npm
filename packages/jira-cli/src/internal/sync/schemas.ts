/**
 * Runtime schemas for Jira Markdown Sync local workspace files.
 *
 * @internal
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { FIELD_CONTRACTS } from "./types.js"

const SiteUrl = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^https:\/\/[a-z0-9][a-z0-9-]*\.atlassian\.net$/))
)

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isMinLength(1)))
const FilenameModes: readonly ["convention", "custom"] = ["convention", "custom"]

export const FieldContractSchema = Schema.Literals(FIELD_CONTRACTS)

export const RequestedCustomFieldSchema = Schema.Struct({
  displayName: NonEmptyString,
  fieldId: Schema.optional(NonEmptyString),
  form: FieldContractSchema,
  ordered: Schema.optional(Schema.Boolean)
}).pipe(Schema.encodeKeys({ form: "shape" }))

export const WorkspaceConfigSchema = Schema.Struct({
  version: Schema.Literal(1).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(1))),
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
  filenameMode: Schema.Literals(FilenameModes)
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
  form: FieldContractSchema,
  value: SyncFieldValueSchema
}).pipe(Schema.encodeKeys({ form: "shape" }))

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
