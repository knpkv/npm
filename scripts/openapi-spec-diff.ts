/**
 * Classifies an upstream OpenAPI document change as the semver release its generated
 * client needs. The API update workflows run it through `openapi-changeset.ts`:
 *
 *   classify(previousSpec, updatedSpec) // { bump: "major", changes: [{ level, at, change }] }
 *
 * major: something a consumer relied on is gone or incompatible: a removed path,
 *   operation, schema, property, enum member, parameter, response or content type; a
 *   changed type or reference; a new requirement on what callers send; a field that
 *   responses may now omit.
 * minor: additions only.
 * patch: no contract change (descriptions, examples, ordering).
 *
 * A schema's direction decides the ambiguous cases: one reached from a parameter or
 * request body is input, one reached from a response is output, and a schema reached
 * from neither (or both) is treated as both.
 */
import * as Predicate from "effect/Predicate"
import type * as Schema from "effect/Schema"

export type Level = "major" | "minor"
export type Bump = Level | "patch"

export interface Change {
  readonly level: Level
  /** JSON pointer into the updated document, or the previous one for a removal. */
  readonly at: string
  readonly change: string
}

export interface Classification {
  readonly bump: Bump
  readonly changes: ReadonlyArray<Change>
}

type JsonRecord = { readonly [key: string]: Schema.Json }

interface Usage {
  readonly input: boolean
  readonly output: boolean
}

const BOTH: Usage = { input: true, output: true }
const INPUT: Usage = { input: true, output: false }
const OUTPUT: Usage = { input: false, output: true }
const METHODS: ReadonlyArray<string> = ["get", "put", "post", "delete", "options", "head", "patch", "trace"]
const DOC_KEYS = new Set(["description", "summary", "title", "example", "examples", "externalDocs"])

const isRecord = (value: Schema.Json | undefined): value is JsonRecord =>
  Predicate.isObjectOrArray(value) && value !== null && !Array.isArray(value)

const record = (value: Schema.Json | undefined): JsonRecord => isRecord(value) ? value : {}

const list = (value: Schema.Json | undefined): ReadonlyArray<Schema.Json> => Array.isArray(value) ? value : []

const strings = (value: Schema.Json | undefined): ReadonlySet<string> => new Set(list(value).filter(Predicate.isString))

const pointer = (segment: string): string => segment.replaceAll("~", "~0").replaceAll("/", "~1")

const change = (level: Level, at: string, description: string): Change => ({ level, at, change: description })

/**
 * Maps whose keys are names the API chose (a property called `description`, a response
 * called `title`), not keywords: every key of these is contract.
 */
const NAMED_MAPS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "content",
  "responses",
  "parameters",
  "requestBodies",
  "headers",
  "schemas",
  "securitySchemes"
])

/**
 * Key-order-independent JSON identity, ignoring documentation-only keywords. `named` marks
 * a map keyed by API-chosen names, whose keys are all kept.
 */
const canonical = (value: Schema.Json | undefined, named = false): string => {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`
  if (isRecord(value)) {
    return `{${
      Object.keys(value).filter((key) => named || !DOC_KEYS.has(key)).sort().map((key) =>
        `${JSON.stringify(key)}:${canonical(value[key], !named && NAMED_MAPS.has(key))}`
      ).join(",")
    }}`
  }
  return JSON.stringify(value) ?? "undefined"
}

const same = (before: Schema.Json | undefined, after: Schema.Json | undefined): boolean =>
  canonical(before) === canonical(after)

const render = (value: Schema.Json): string => Predicate.isString(value) ? value : JSON.stringify(value)

/** The keys only `before` has, only `after` has, and both have. */
interface KeyDiff {
  readonly removed: ReadonlyArray<string>
  readonly added: ReadonlyArray<string>
  readonly common: ReadonlyArray<string>
}

const keyed = <A>(before: ReadonlyMap<string, A>, after: ReadonlyMap<string, A>): KeyDiff => ({
  removed: [...before.keys()].filter((key) => !after.has(key)),
  added: [...after.keys()].filter((key) => !before.has(key)),
  common: [...before.keys()].filter((key) => after.has(key))
})

const entries = (value: Schema.Json | undefined): ReadonlyMap<string, Schema.Json> =>
  new Map(Object.entries(record(value)))

const typeOf = (schema: JsonRecord): string => {
  const declared = Array.isArray(schema.type)
    ? schema.type.filter(Predicate.isString)
    : Predicate.isString(schema.type)
    ? [schema.type]
    : []
  const types = schema.nullable === true ? [...declared, "null"] : declared
  return types.length === 0 ? "any" : [...new Set(types)].sort().join(" | ")
}

const compareEnum = (at: string, before: JsonRecord, after: JsonRecord, usage: Usage): ReadonlyArray<Change> => {
  if (!Array.isArray(before.enum) && !Array.isArray(after.enum)) return []
  if (!Array.isArray(before.enum)) return [change(usage.input ? "major" : "minor", at, "enum constraint added")]
  if (!Array.isArray(after.enum)) return [change(usage.output ? "major" : "minor", at, "enum constraint removed")]
  const previous = new Map(before.enum.map((member) => [canonical(member), member]))
  const updated = new Map(after.enum.map((member) => [canonical(member), member]))
  const { added, removed } = keyed(previous, updated)
  return [
    ...removed.flatMap((key) => {
      const member = previous.get(key)
      return member === undefined ? [] : [change("major", at, `removed enum member ${render(member)}`)]
    }),
    ...added.flatMap((key) => {
      const member = updated.get(key)
      return member === undefined ? [] : [change("minor", at, `added enum member ${render(member)}`)]
    })
  ]
}

const compareProperties = (at: string, before: JsonRecord, after: JsonRecord, usage: Usage): ReadonlyArray<Change> => {
  const previous = entries(before.properties)
  const updated = entries(after.properties)
  const wasRequired = strings(before.required)
  const isRequired = strings(after.required)
  const { added, common, removed } = keyed(previous, updated)
  return [
    ...removed.map((name) => change("major", at, `removed property ${name}`)),
    ...added.map((name) =>
      isRequired.has(name)
        ? change(usage.input ? "major" : "minor", at, `added required property ${name}`)
        : change("minor", at, `added property ${name}`)
    ),
    ...common.flatMap((name) => [
      ...(isRequired.has(name) && !wasRequired.has(name)
        ? [change(usage.input ? "major" : "minor", at, `property ${name} became required`)]
        : []),
      ...(wasRequired.has(name) && !isRequired.has(name)
        ? [change(usage.output ? "major" : "minor", at, `property ${name} became optional`)]
        : []),
      ...compareSchema(`${at}/properties/${pointer(name)}`, previous.get(name), updated.get(name), usage)
    ])
  ]
}

/** Keywords the pinned generator enforces in its decoders, by which direction narrows. */
const LOWER_BOUNDS = ["minLength", "minimum", "minItems", "minProperties", "exclusiveMinimum"]
const UPPER_BOUNDS = ["maxLength", "maximum", "maxItems", "maxProperties", "exclusiveMaximum"]
const EXACT_CONSTRAINTS = ["pattern", "multipleOf", "format", "const"]

/** Narrowing a constraint rejects values the published client accepted: major. Widening: minor. */
const compareConstraints = (at: string, before: JsonRecord, after: JsonRecord): ReadonlyArray<Change> => {
  const bound = (key: string, narrows: (previous: number, updated: number) => boolean): ReadonlyArray<Change> => {
    const previous = before[key]
    const updated = after[key]
    if (same(previous, updated)) return []
    if (previous === undefined && updated !== undefined) {
      return [change("major", at, `${key} added: ${render(updated)}`)]
    }
    if (previous !== undefined && updated === undefined) {
      return [change("minor", at, `${key} removed (was ${render(previous)})`)]
    }
    if (previous === undefined || updated === undefined) return []
    // OpenAPI 3.0's boolean exclusive bounds, or any non-numeric value, cannot be ordered.
    const level = Predicate.isNumber(previous) && Predicate.isNumber(updated) && !narrows(previous, updated)
      ? "minor"
      : "major"
    return [change(level, at, `${key} changed from ${render(previous)} to ${render(updated)}`)]
  }
  const unique = (before.uniqueItems === true) === (after.uniqueItems === true)
    ? []
    : [
      change(
        after.uniqueItems === true ? "major" : "minor",
        at,
        `uniqueItems changed from ${String(before.uniqueItems === true)} to ${String(after.uniqueItems === true)}`
      )
    ]
  return [
    ...LOWER_BOUNDS.flatMap((key) => bound(key, (previous, updated) => updated > previous)),
    ...UPPER_BOUNDS.flatMap((key) => bound(key, (previous, updated) => updated < previous)),
    ...EXACT_CONSTRAINTS.flatMap((key) => bound(key, () => true)),
    ...unique
  ]
}

/**
 * Members are matched by content first, so reordering them is no change; only the members
 * left unmatched on either side are compared, in order, or reported as removed or added.
 */
const compareVariants = (
  at: string,
  key: "allOf" | "oneOf" | "anyOf",
  before: JsonRecord,
  after: JsonRecord,
  usage: Usage
): ReadonlyArray<Change> => {
  const previous = list(before[key]).map((schema, index) => ({ schema, index, id: canonical(schema) }))
  const updated = list(after[key]).map((schema, index) => ({ schema, index, id: canonical(schema) }))
  const unmatchedUpdated = [...updated]
  const unmatchedPrevious = previous.filter((member) => {
    const match = unmatchedUpdated.findIndex((candidate) => candidate.id === member.id)
    if (match === -1) return true
    unmatchedUpdated.splice(match, 1)
    return false
  })
  return [
    ...unmatchedPrevious.flatMap((member, position) => {
      const counterpart = unmatchedUpdated[position]
      return counterpart === undefined
        ? [change("major", at, `removed ${key} member ${member.index}`)]
        : compareSchema(`${at}/${key}/${counterpart.index}`, member.schema, counterpart.schema, usage)
    }),
    // A new allOf member constrains every value; a new oneOf/anyOf member only widens.
    ...unmatchedUpdated.slice(unmatchedPrevious.length).map((member) =>
      change(key === "allOf" ? "major" : "minor", at, `added ${key} member ${member.index}`)
    )
  ]
}

const compareSchema = (
  at: string,
  before: Schema.Json | undefined,
  after: Schema.Json | undefined,
  usage: Usage
): ReadonlyArray<Change> => {
  if (!isRecord(before) || !isRecord(after)) {
    return same(before, after) ? [] : [change("major", at, "schema changed")]
  }
  if (Predicate.isString(before.$ref) || Predicate.isString(after.$ref)) {
    const from = Predicate.isString(before.$ref) ? before.$ref : "an inline schema"
    const to = Predicate.isString(after.$ref) ? after.$ref : "an inline schema"
    return from === to ? [] : [change("major", at, `reference changed from ${from} to ${to}`)]
  }
  const previousType = typeOf(before)
  const updatedType = typeOf(after)
  if (previousType !== updatedType) {
    return [change("major", at, `type changed from ${previousType} to ${updatedType}`)]
  }
  const nested = (key: "items" | "additionalProperties"): ReadonlyArray<Change> =>
    isRecord(before[key]) && isRecord(after[key])
      ? compareSchema(`${at}/${key}`, before[key], after[key], usage)
      : same(before[key], after[key])
      ? []
      : [change("major", at, `${key} changed`)]
  return [
    ...compareEnum(at, before, after, usage),
    ...compareConstraints(at, before, after),
    ...compareProperties(at, before, after, usage),
    ...nested("items"),
    ...nested("additionalProperties"),
    ...compareVariants(at, "allOf", before, after, usage),
    ...compareVariants(at, "oneOf", before, after, usage),
    ...compareVariants(at, "anyOf", before, after, usage)
  ]
}

/** Component schema names reachable through `$ref`s from `roots`, following other components too. */
const reachableSchemas = (spec: JsonRecord, roots: ReadonlyArray<Schema.Json>): ReadonlySet<string> => {
  const components = record(spec.components)
  const visitedRefs = new Set<string>()
  // Children of a node, plus the component a first-seen `$ref` points at.
  const children = (value: Schema.Json): ReadonlyArray<Schema.Json> => {
    if (Array.isArray(value)) return value
    if (!isRecord(value)) return []
    const ref = value.$ref
    if (!Predicate.isString(ref) || visitedRefs.has(ref)) return Object.values(value)
    visitedRefs.add(ref)
    const [kind, name] = ref.replace(/^#\/components\//u, "").split("/")
    const target = kind === undefined || name === undefined
      ? undefined
      : record(components[kind])[name.replaceAll("~1", "/").replaceAll("~0", "~")]
    return target === undefined ? Object.values(value) : [target, ...Object.values(value)]
  }
  const queue: Array<Schema.Json> = [...roots]
  for (let index = 0; index < queue.length; index++) {
    const value = queue[index]
    if (value !== undefined) { for (const child of children(value)) queue.push(child) }
  }
  return new Set(
    [...visitedRefs].flatMap((ref) => {
      const match = /^#\/components\/schemas\/(.+)$/u.exec(ref)?.[1]
      return match === undefined ? [] : [match.replaceAll("~1", "/").replaceAll("~0", "~")]
    })
  )
}

const operationsOf = (spec: JsonRecord): ReadonlyArray<JsonRecord> =>
  Object.values(record(spec.paths)).flatMap((pathItem) =>
    METHODS.flatMap((method) => {
      const operation = record(pathItem)[method]
      return isRecord(operation) ? [{ ...operation, pathParameters: record(pathItem).parameters ?? [] }] : []
    })
  )

const usageOf = (spec: JsonRecord): (name: string) => Usage => {
  const operations = operationsOf(spec)
  const input = reachableSchemas(
    spec,
    operations.flatMap((
      operation
    ) => [operation.pathParameters ?? [], operation.parameters ?? [], operation.requestBody ?? null])
  )
  const output = reachableSchemas(spec, operations.map((operation) => operation.responses ?? null))
  return (name) => {
    const used = { input: input.has(name), output: output.has(name) }
    return used.input || used.output ? used : BOTH
  }
}

const compareComponents = (
  previousSpec: JsonRecord,
  updatedSpec: JsonRecord,
  usage: (name: string) => Usage
): ReadonlyArray<Change> => {
  const previous = record(previousSpec.components)
  const updated = record(updatedSpec.components)
  const kinds = new Set([...Object.keys(previous), ...Object.keys(updated)])
  return [...kinds].sort().flatMap((kind) => {
    const at = `#/components/${pointer(kind)}`
    const before = entries(previous[kind])
    const after = entries(updated[kind])
    const { added, common, removed } = keyed(before, after)
    const noun = kind === "schemas" ? "schema" : kind === "securitySchemes" ? "security scheme" : `${kind} component`
    return [
      ...removed.map((name) => change("major", at, `removed ${noun} ${name}`)),
      ...added.map((name) => change("minor", at, `added ${noun} ${name}`)),
      ...common.flatMap((name) =>
        kind === "schemas"
          ? compareSchema(`${at}/${pointer(name)}`, before.get(name), after.get(name), usage(name))
          : same(before.get(name), after.get(name))
          ? []
          : [change("major", `${at}/${pointer(name)}`, `changed ${noun} ${name}`)]
      )
    ]
  })
}

const resolve = (spec: JsonRecord, value: Schema.Json | undefined): Schema.Json | undefined => {
  const ref = record(value).$ref
  if (!Predicate.isString(ref)) return value
  const [kind, name] = ref.replace(/^#\/components\//u, "").split("/")
  return kind === undefined || name === undefined ? value : record(record(spec.components)[kind])[name] ?? value
}

const parametersOf = (spec: JsonRecord, pathItem: JsonRecord, operation: JsonRecord): ReadonlyMap<string, JsonRecord> =>
  new Map(
    [...list(pathItem.parameters), ...list(operation.parameters)].flatMap(
      (parameter): ReadonlyArray<readonly [string, JsonRecord]> => {
        const resolved = record(resolve(spec, parameter))
        return Predicate.isString(resolved.name) && Predicate.isString(resolved.in)
          ? [[`${resolved.in} parameter ${resolved.name}`, resolved]]
          : []
      }
    )
  )

const compareContent = (
  at: string,
  label: string,
  before: JsonRecord,
  after: JsonRecord,
  usage: Usage
): ReadonlyArray<Change> => {
  const previous = entries(before.content)
  const updated = entries(after.content)
  const { added, common, removed } = keyed(previous, updated)
  return [
    ...removed.map((type) => change("major", at, `removed ${label} content type ${type}`)),
    ...added.map((type) => change("minor", at, `added ${label} content type ${type}`)),
    ...common.flatMap((type) =>
      compareSchema(
        `${at}/content/${pointer(type)}/schema`,
        record(previous.get(type)).schema,
        record(updated.get(type)).schema,
        usage
      )
    )
  ]
}

const compareOperation = (
  at: string,
  specs: { readonly before: JsonRecord; readonly after: JsonRecord },
  pathItems: { readonly before: JsonRecord; readonly after: JsonRecord },
  before: JsonRecord,
  after: JsonRecord
): ReadonlyArray<Change> => {
  const previousParameters = parametersOf(specs.before, pathItems.before, before)
  const updatedParameters = parametersOf(specs.after, pathItems.after, after)
  const parameters = keyed(previousParameters, updatedParameters)
  const previousBody = record(resolve(specs.before, before.requestBody))
  const updatedBody = record(resolve(specs.after, after.requestBody))
  const previousResponses = entries(before.responses)
  const updatedResponses = entries(after.responses)
  const responses = keyed(previousResponses, updatedResponses)
  const hadBody = before.requestBody !== undefined
  const hasBody = after.requestBody !== undefined
  // The generator names the client method and its request/response exports after the operation id.
  const previousId = Predicate.isString(before.operationId) ? before.operationId : "(none)"
  const updatedId = Predicate.isString(after.operationId) ? after.operationId : "(none)"
  return [
    ...(previousId === updatedId
      ? []
      : [change("major", at, `operation id changed from ${previousId} to ${updatedId}`)]),
    ...parameters.removed.map((key) => change("major", at, `removed ${key}`)),
    ...parameters.added.map((key) =>
      updatedParameters.get(key)?.required === true
        ? change("major", at, `added required ${key}`)
        : change("minor", at, `added ${key}`)
    ),
    ...parameters.common.flatMap((key) => {
      const previous = previousParameters.get(key) ?? {}
      const updated = updatedParameters.get(key) ?? {}
      return [
        ...(updated.required === true && previous.required !== true
          ? [change("major", at, `${key} became required`)]
          : []),
        ...compareSchema(`${at}/parameters/${pointer(String(updated.name))}`, previous.schema, updated.schema, INPUT)
      ]
    }),
    ...(hadBody && !hasBody ? [change("major", at, "removed request body")] : []),
    ...(!hadBody && hasBody
      ? [change(updatedBody.required === true ? "major" : "minor", at, "added request body")]
      : []),
    ...(hadBody && hasBody
      ? [
        ...(updatedBody.required === true && previousBody.required !== true
          ? [change("major", at, "request body became required")]
          : []),
        ...compareContent(`${at}/requestBody`, "request", previousBody, updatedBody, INPUT)
      ]
      : []),
    ...responses.removed.map((status) => change("major", at, `removed response ${status}`)),
    ...responses.added.map((status) => change("minor", at, `added response ${status}`)),
    ...responses.common.flatMap((status) =>
      compareContent(
        `${at}/responses/${pointer(status)}`,
        `response ${status}`,
        record(resolve(specs.before, previousResponses.get(status))),
        record(resolve(specs.after, updatedResponses.get(status))),
        OUTPUT
      )
    )
  ]
}

const comparePaths = (previousSpec: JsonRecord, updatedSpec: JsonRecord): ReadonlyArray<Change> => {
  const previous = entries(previousSpec.paths)
  const updated = entries(updatedSpec.paths)
  const { added, common, removed } = keyed(previous, updated)
  return [
    ...removed.map((path) => change("major", "#/paths", `removed path ${path}`)),
    ...added.map((path) => change("minor", "#/paths", `added path ${path}`)),
    ...common.flatMap((path) => {
      const at = `#/paths/${pointer(path)}`
      const before = record(previous.get(path))
      const after = record(updated.get(path))
      return METHODS.flatMap((method) => {
        const operation = `${method.toUpperCase()} ${path}`
        if (isRecord(before[method]) && !isRecord(after[method])) {
          return [change("major", at, `removed operation ${operation}`)]
        }
        if (!isRecord(before[method]) && isRecord(after[method])) {
          return [change("minor", at, `added operation ${operation}`)]
        }
        return isRecord(before[method]) && isRecord(after[method])
          ? compareOperation(
            `${at}/${method}`,
            { before: previousSpec, after: updatedSpec },
            { before, after },
            before[method],
            after[method]
          )
          : []
      })
    })
  ]
}

const noteList = (heading: string, changes: ReadonlyArray<Change>, limit: number): ReadonlyArray<string> =>
  changes.length === 0 ? [] : [
    "",
    `${heading}:`,
    ...changes.slice(0, limit).map((entry) => `- ${entry.change} at \`${entry.at.replaceAll("`", "'")}\``),
    ...(changes.length > limit ? [`- and ${changes.length - limit} more`] : [])
  ]

const count = (amount: number, noun: string): string => `${amount} ${noun}${amount === 1 ? "" : "s"}`

/**
 * Markdown for the changeset and the update pull request:
 *
 *   releaseNotes(classify(previous, updated)) // "Release: major (2 breaking, 1 addition).\n\nBreaking:\n- ..."
 *
 * Lists at most `limit` changes per level, breaking first.
 */
export const releaseNotes = (classification: Classification, limit = 10): string => {
  const breaking = classification.changes.filter((entry) => entry.level === "major")
  const additions = classification.changes.filter((entry) => entry.level === "minor")
  if (classification.changes.length === 0) return `Release: ${classification.bump} (no contract change).`
  return [
    `Release: ${classification.bump} (${breaking.length} breaking, ${count(additions.length, "addition")}).`,
    ...noteList("Breaking", breaking, limit),
    ...noteList("Additions", additions, limit)
  ].join("\n")
}

/** The release `updated` needs relative to `previous`, with every change that decided it. */
export const classify = (previous: Schema.Json, updated: Schema.Json): Classification => {
  const before = record(previous)
  const after = record(updated)
  const previousUsage = usageOf(before)
  const updatedUsage = usageOf(after)
  const usage = (name: string): Usage => {
    const was = previousUsage(name)
    const is = updatedUsage(name)
    return { input: was.input || is.input, output: was.output || is.output }
  }
  const changes = [...compareComponents(before, after, usage), ...comparePaths(before, after)]
  const bump: Bump = changes.some((entry) => entry.level === "major")
    ? "major"
    : changes.length > 0
    ? "minor"
    : "patch"
  return { bump, changes }
}
