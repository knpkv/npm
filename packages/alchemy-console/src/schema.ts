import { Schema } from "effect"

/** Bounded normalized resource identity, not a filesystem path or provider locator. */
export const ResourceFqn = Schema.NonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.isPattern(/^\P{Cc}+$/u),
  Schema.isPattern(/^[^/]+(?:\/[^/]+)*$/)
)

export const ResourceSummary = Schema.Struct({
  fqn: ResourceFqn,
  logicalId: Schema.NonEmptyString,
  resourceType: Schema.NonEmptyString,
  status: Schema.Literals(["creating", "created", "updating", "updated", "deleting", "replacing", "replaced"]),
  parent: Schema.NullOr(ResourceFqn),
  providerId: Schema.NullOr(Schema.String),
  account: Schema.NullOr(Schema.String),
  region: Schema.NullOr(Schema.String),
  consoleUrl: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
  downstream: Schema.NullOr(Schema.Array(ResourceFqn).check(Schema.isMaxLength(50_000)))
})
export interface ResourceSummary extends Schema.Schema.Type<typeof ResourceSummary> {}

/** Output keys cross authenticated HTTP; persisted values never do. Plaintext is not proof of safety. */
export const OutputSummary = Schema.Struct({
  key: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  value: Schema.TaggedStruct("Hidden", {}),
  description: Schema.Null
})
export interface OutputSummary extends Schema.Schema.Type<typeof OutputSummary> {}

/** Authenticated resource-own identity and output keys. No backend locators, props, output values or credentials. */
export const StackState = Schema.Struct({
  app: Schema.NonEmptyString,
  stage: Schema.NonEmptyString,
  backend: Schema.Literals(["local", "s3"]),
  alchemyVersion: Schema.NullOr(Schema.String),
  lastDeploy: Schema.NullOr(Schema.String),
  resources: Schema.Array(ResourceSummary).check(Schema.isMaxLength(50_000)),
  outputs: Schema.NullOr(Schema.Array(OutputSummary).check(Schema.isMaxLength(1000)))
})
export interface StackState extends Schema.Schema.Type<typeof StackState> {}

/** Contains no source input, parser diagnostics, provider locators, or underlying filesystem errors. */
export class StateReadError extends Schema.TaggedError<StateReadError>()("StateReadError", {
  reason: Schema.Literals(["io", "invalid-state", "invalid-lockfile", "unsupported-version", "limit", "outside-root"])
}) {}
