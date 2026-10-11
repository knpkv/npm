import { Effect, Option, Predicate, Schema } from "effect"
import { projectResourceIdentity } from "./internal/resource-identity.js"
import { ResourceSummary, StateReadError } from "./schema.js"

const ResourceRow = Schema.Struct({
  kind: Schema.optionalKey(Schema.Literal("resource")),
  fqn: ResourceSummary.fields.fqn,
  logicalId: Schema.NonEmptyString,
  resourceType: Schema.NonEmptyString,
  status: ResourceSummary.fields.status
})
const ActionRow = Schema.Struct({
  kind: Schema.Literal("action"),
  fqn: ResourceSummary.fields.fqn,
  logicalId: Schema.NonEmptyString,
  actionType: Schema.NonEmptyString,
  status: Schema.Literals(["running", "ran"])
})

const metadataKeys = ["kind", "fqn", "logicalId", "resourceType", "actionType", "status"]
const Downstream = Schema.Array(ResourceSummary.fields.fqn).check(Schema.isMaxLength(50_000))

/** Select resource metadata only. Own identity has a separate allowlist; raw props and output values never pass through. */
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
    ...projectResourceIdentity(row.resourceType, json),
    downstream: Option.getOrNull(Schema.decodeUnknownOption(Downstream)(json.downstream))
  })
})
