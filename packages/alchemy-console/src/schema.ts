import { Schema } from "effect"

export const ResourceSummary = Schema.Struct({
  fqn: Schema.NonEmptyString,
  logicalId: Schema.NonEmptyString,
  resourceType: Schema.NonEmptyString,
  status: Schema.Literals(["creating", "created", "updating", "updated", "deleting", "replacing", "replaced"]),
  parent: Schema.NullOr(Schema.String),
  providerId: Schema.NullOr(Schema.String),
  account: Schema.NullOr(Schema.String),
  region: Schema.NullOr(Schema.String),
  consoleUrl: Schema.NullOr(Schema.String)
})
export interface ResourceSummary extends Schema.Schema.Type<typeof ResourceSummary> {}

/** Safe metadata for an authenticated owner. Never includes state paths, props, outputs, or credentials. */
export const StackState = Schema.Struct({
  app: Schema.NonEmptyString,
  stage: Schema.NonEmptyString,
  backend: Schema.Literals(["local", "s3"]),
  alchemyVersion: Schema.NullOr(Schema.String),
  lastDeploy: Schema.NullOr(Schema.String),
  resources: Schema.Array(ResourceSummary)
})
export interface StackState extends Schema.Schema.Type<typeof StackState> {}

/** Contains no source input, parser diagnostics, provider locators, or underlying filesystem errors. */
export class StateReadError extends Schema.TaggedError<StateReadError>()("StateReadError", {
  reason: Schema.Literals(["io", "invalid-state", "invalid-lockfile", "unsupported-version", "limit", "outside-root"])
}) {}
