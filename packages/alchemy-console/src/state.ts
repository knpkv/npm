import { Effect, Predicate, Schema } from "effect"
import { ResourceSummary, StateReadError } from "./schema.js"

const ResourceRow = Schema.Struct({
  kind: Schema.optionalKey(Schema.Literal("resource")),
  fqn: Schema.NonEmptyString,
  logicalId: Schema.NonEmptyString,
  resourceType: Schema.NonEmptyString,
  status: ResourceSummary.fields.status
})
const ActionRow = Schema.Struct({
  kind: Schema.Literal("action"),
  fqn: Schema.NonEmptyString,
  logicalId: Schema.NonEmptyString,
  actionType: Schema.NonEmptyString,
  status: Schema.Literals(["running", "ran"])
})

const metadataKeys = ["kind", "fqn", "logicalId", "resourceType", "actionType", "status"]

/** Discard properties and outputs entirely. Mask marker objects in metadata, including their siblings. */
const metadata = (value: Schema.JsonObject): Schema.JsonObject | null => {
  if (Object.hasOwn(value, "__redacted__")) return null
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => metadataKeys.includes(key)).map(([key, field]) => {
      return [key, Predicate.isObject(field) && Object.hasOwn(field, "__redacted__") ? "<redacted>" : field]
    })
  )
}

/** Decode persisted beta.74/beta.77 JSON into metadata; action rows are validated and excluded. */
export const decodeResource = Effect.fn("AlchemyConsole.decodeResource")(function*(text: string) {
  const json = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.JsonObject))(text).pipe(
    Effect.mapError(() => new StateReadError({ reason: "invalid-state" }))
  )
  const row = yield* Schema.decodeUnknownEffect(Schema.Union([ResourceRow, ActionRow]))(metadata(json)).pipe(
    Effect.mapError(() => new StateReadError({ reason: "invalid-state" }))
  )
  if (row.kind === "action") return null
  const slash = row.fqn.lastIndexOf("/")
  return ResourceSummary.make({
    fqn: row.fqn,
    logicalId: row.logicalId,
    resourceType: row.resourceType,
    status: row.status,
    parent: slash === -1 ? null : row.fqn.slice(0, slash),
    providerId: null,
    account: null,
    region: null,
    consoleUrl: null
  })
})
