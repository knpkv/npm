import assert from "node:assert/strict"
import test from "node:test"

import type * as Schema from "effect/Schema"

import * as Prettier from "prettier"

import { type Classification, classify, releaseNotes } from "./openapi-spec-diff.ts"

// One spec builder for every fixture: `Plan` is read by GET /plans (output only),
// `NewPlan` is the body of POST /plans (input only).
const spec = (overrides: {
  readonly paths?: Record<string, Schema.Json>
  readonly plan?: Record<string, Schema.Json>
  readonly newPlan?: Record<string, Schema.Json>
  readonly extraSchemas?: Record<string, Schema.Json>
  readonly getParameters?: ReadonlyArray<Schema.Json>
  readonly responses?: Record<string, Schema.Json>
} = {}): Schema.Json => ({
  openapi: "3.0.1",
  info: { title: "Fixture", version: "1" },
  paths: overrides.paths ?? {
    "/plans": {
      get: {
        parameters: [...(overrides.getParameters ?? [{ name: "page", in: "query", schema: { type: "integer" } }])],
        responses: {
          "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Plan" } } } }
        }
      },
      post: {
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/NewPlan" } } }
        },
        responses: { "204": { description: "created" } }
      }
    }
  },
  components: {
    schemas: {
      Plan: overrides.plan ?? {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          note: { type: "string", description: "free text" },
          featurePermissions: {
            type: "array",
            items: { type: "string", enum: ["DEFAULT_BILLABLE_PROJECT", "TIME_ENTRY_ROUNDING"] }
          }
        }
      },
      NewPlan: overrides.newPlan ?? {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" }, color: { type: "string" } }
      },
      ...overrides.extraSchemas
    },
    responses: overrides.responses ?? {}
  }
})

const plan = (patch: (properties: Record<string, Schema.Json>) => Record<string, Schema.Json>, required = ["id"]) => ({
  type: "object",
  required,
  properties: patch({
    id: { type: "string" },
    note: { type: "string", description: "free text" },
    featurePermissions: {
      type: "array",
      items: { type: "string", enum: ["DEFAULT_BILLABLE_PROJECT", "TIME_ENTRY_ROUNDING"] }
    }
  })
})

const newPlan = (properties: Record<string, Schema.Json>, required = ["name"]) => ({
  type: "object",
  required,
  properties
})

test("an unchanged spec is a patch with no reasons", () => {
  assert.deepEqual(classify(spec(), spec()), { bump: "patch", changes: [] })
})

test("a description-only change is a patch", () => {
  const after = spec({ plan: plan((p) => ({ ...p, note: { type: "string", description: "longer free text" } })) })
  assert.equal(classify(spec(), after).bump, "patch")
})

test("a removed enum member is major and names the member", () => {
  const after = spec({
    plan: plan((p) => ({
      ...p,
      featurePermissions: { type: "array", items: { type: "string", enum: ["TIME_ENTRY_ROUNDING"] } }
    }))
  })
  assert.deepEqual(classify(spec(), after), {
    bump: "major",
    changes: [{
      level: "major",
      at: "#/components/schemas/Plan/properties/featurePermissions/items",
      change: "removed enum member DEFAULT_BILLABLE_PROJECT"
    }]
  })
})

test("an added enum member is minor", () => {
  const after = spec({
    plan: plan((p) => ({
      ...p,
      featurePermissions: {
        type: "array",
        items: { type: "string", enum: ["DEFAULT_BILLABLE_PROJECT", "TIME_ENTRY_ROUNDING", "KIOSK"] }
      }
    }))
  })
  assert.deepEqual(classify(spec(), after).changes, [{
    level: "minor",
    at: "#/components/schemas/Plan/properties/featurePermissions/items",
    change: "added enum member KIOSK"
  }])
})

test("a removed property is major", () => {
  const after = spec({ plan: plan(({ note: _note, ...p }) => p) })
  assert.deepEqual(classify(spec(), after).changes, [{
    level: "major",
    at: "#/components/schemas/Plan",
    change: "removed property note"
  }])
})

test("an added optional property is minor", () => {
  const after = spec({ plan: plan((p) => ({ ...p, archived: { type: "boolean" } })) })
  assert.deepEqual(classify(spec(), after).changes, [{
    level: "minor",
    at: "#/components/schemas/Plan",
    change: "added property archived"
  }])
})

test("a new required property is major in a request schema and minor in a response schema", () => {
  const request = spec({
    newPlan: newPlan({ name: { type: "string" }, color: { type: "string" }, owner: { type: "string" } }, [
      "name",
      "owner"
    ])
  })
  assert.deepEqual(classify(spec(), request).changes, [{
    level: "major",
    at: "#/components/schemas/NewPlan",
    change: "added required property owner"
  }])
  const response = spec({ plan: plan((p) => ({ ...p, owner: { type: "string" } }), ["id", "owner"]) })
  assert.deepEqual(classify(spec(), response).changes, [{
    level: "minor",
    at: "#/components/schemas/Plan",
    change: "added required property owner"
  }])
})

test("an existing property turning required is major in a request schema", () => {
  const after = spec({ newPlan: newPlan({ name: { type: "string" }, color: { type: "string" } }, ["name", "color"]) })
  assert.deepEqual(classify(spec(), after).changes, [{
    level: "major",
    at: "#/components/schemas/NewPlan",
    change: "property color became required"
  }])
})

test("a required property turning optional is major in a response schema", () => {
  const after = spec({ plan: plan((p) => p, []) })
  assert.deepEqual(classify(spec(), after).changes, [{
    level: "major",
    at: "#/components/schemas/Plan",
    change: "property id became optional"
  }])
})

test("a changed type is major, including a newly nullable one", () => {
  const retyped = spec({ plan: plan((p) => ({ ...p, id: { type: "integer" } })) })
  assert.deepEqual(classify(spec(), retyped).changes, [{
    level: "major",
    at: "#/components/schemas/Plan/properties/id",
    change: "type changed from string to integer"
  }])
  const nullable = spec({ plan: plan((p) => ({ ...p, id: { type: "string", nullable: true } })) })
  assert.deepEqual(classify(spec(), nullable).changes, [{
    level: "major",
    at: "#/components/schemas/Plan/properties/id",
    change: "type changed from string to null | string"
  }])
})

test("a changed reference is major", () => {
  const after = spec({
    plan: plan((p) => ({ ...p, owner: { $ref: "#/components/schemas/NewPlan" } })),
    extraSchemas: {}
  })
  const before = spec({ plan: plan((p) => ({ ...p, owner: { $ref: "#/components/schemas/Plan" } })) })
  assert.deepEqual(classify(before, after).changes, [{
    level: "major",
    at: "#/components/schemas/Plan/properties/owner",
    change: "reference changed from #/components/schemas/Plan to #/components/schemas/NewPlan"
  }])
})

test("a removed schema is major and an added schema is minor", () => {
  const withExtra = spec({ extraSchemas: { Kiosk: { type: "object" } } })
  assert.deepEqual(classify(withExtra, spec()).changes, [{
    level: "major",
    at: "#/components/schemas",
    change: "removed schema Kiosk"
  }])
  assert.deepEqual(classify(spec(), withExtra).changes, [{
    level: "minor",
    at: "#/components/schemas",
    change: "added schema Kiosk"
  }])
})

test("a removed operation or path is major and an added one is minor", () => {
  const operations = (methods: Record<string, Schema.Json>) => spec({ paths: { "/plans": methods } })
  const get = { responses: { "200": { description: "ok" } } }
  const post = { responses: { "204": { description: "created" } } }
  assert.deepEqual(classify(operations({ get, post }), operations({ get })).changes, [{
    level: "major",
    at: "#/paths/~1plans",
    change: "removed operation POST /plans"
  }])
  assert.deepEqual(classify(operations({ get }), operations({ get, post })).changes, [{
    level: "minor",
    at: "#/paths/~1plans",
    change: "added operation POST /plans"
  }])
  assert.deepEqual(classify(spec(), spec({ paths: {} })).bump, "major")
})

test("parameters: removed or newly required is major, a new optional one is minor", () => {
  const page = { name: "page", in: "query", schema: { type: "integer" } }
  const at = "#/paths/~1plans/get"
  assert.deepEqual(classify(spec(), spec({ getParameters: [] })).changes, [{
    level: "major",
    at,
    change: "removed query parameter page"
  }])
  assert.deepEqual(classify(spec(), spec({ getParameters: [{ ...page, required: true }] })).changes, [{
    level: "major",
    at,
    change: "query parameter page became required"
  }])
  const size = { name: "size", in: "query", schema: { type: "integer" } }
  assert.deepEqual(classify(spec(), spec({ getParameters: [page, size] })).changes, [{
    level: "minor",
    at,
    change: "added query parameter size"
  }])
  assert.deepEqual(classify(spec(), spec({ getParameters: [page, { ...size, required: true }] })).changes, [{
    level: "major",
    at,
    change: "added required query parameter size"
  }])
})

test("the bump is the highest level, and every change is listed", () => {
  const after = spec({
    plan: plan((p) => ({
      ...p,
      archived: { type: "boolean" },
      featurePermissions: { type: "array", items: { type: "string", enum: ["TIME_ENTRY_ROUNDING"] } }
    }))
  })
  const result = classify(spec(), after)
  assert.equal(result.bump, "major")
  assert.deepEqual(result.changes.map((change) => change.level).sort(), ["major", "minor"])
})

test("release notes list breaking changes before additions and cap each list", () => {
  const classification: Classification = {
    bump: "major",
    changes: [
      { level: "minor", at: "#/paths", change: "added path /kiosks" },
      { level: "major", at: "#/components/schemas/Plan", change: "removed property note" },
      { level: "major", at: "#/components/schemas/Plan", change: "removed property `id`" }
    ]
  }
  assert.equal(
    releaseNotes(classification, 1),
    [
      "Release: major (2 breaking, 1 addition).",
      "",
      "Breaking:",
      "",
      "- removed property note at `#/components/schemas/Plan`",
      "- and 1 more",
      "",
      "Additions:",
      "",
      "- added path /kiosks at `#/paths`"
    ].join("\n")
  )
  assert.equal(releaseNotes({ bump: "patch", changes: [] }), "Release: patch (no contract change).")
})

test("a renamed, added or removed operationId is major: the generated method is renamed", () => {
  const paths = (operation: Record<string, Schema.Json>) =>
    spec({ paths: { "/plans": { get: { ...operation, responses: { "200": { description: "ok" } } } } } })
  const at = "#/paths/~1plans/get"
  assert.deepEqual(classify(paths({ operationId: "getPlan" }), paths({ operationId: "fetchPlan" })).changes, [{
    level: "major",
    at,
    change: "operation id changed from getPlan to fetchPlan"
  }])
  assert.equal(classify(paths({}), paths({ operationId: "getPlan" })).bump, "major")
  assert.equal(classify(paths({ operationId: "getPlan" }), paths({})).bump, "major")
  assert.equal(
    classify(
      paths({ operationId: "getPlan", summary: "Plans" }),
      paths({ operationId: "getPlan", summary: "All plans" })
    )
      .bump,
    "patch"
  )
})

test("validation constraints: tightening is major, loosening is minor, a changed pattern is major", () => {
  const withId = (id: Record<string, Schema.Json>) =>
    spec({ plan: plan((p) => ({ ...p, id: { type: "string", ...id } })) })
  const at = "#/components/schemas/Plan/properties/id"
  const level = (before: Record<string, Schema.Json>, after: Record<string, Schema.Json>) =>
    classify(withId(before), withId(after)).changes.map((entry) => [entry.level, entry.change])
  assert.deepEqual(level({ maxLength: 100 }, { maxLength: 10 }), [["major", "maxLength changed from 100 to 10"]])
  assert.deepEqual(level({ maxLength: 10 }, { maxLength: 100 }), [["minor", "maxLength changed from 10 to 100"]])
  assert.deepEqual(level({}, { minLength: 1 }), [["major", "minLength added: 1"]])
  assert.deepEqual(level({ minLength: 1 }, {}), [["minor", "minLength removed (was 1)"]])
  assert.deepEqual(level({ minimum: 0 }, { minimum: 1 }), [["major", "minimum changed from 0 to 1"]])
  assert.deepEqual(level({ pattern: "^a" }, { pattern: "^b" }), [["major", "pattern changed from ^a to ^b"]])
  assert.deepEqual(level({}, { format: "uuid" }), [["major", "format added: uuid"]])
  assert.deepEqual(level({ uniqueItems: false }, { uniqueItems: true }), [[
    "major",
    "uniqueItems changed from false to true"
  ]])
  assert.equal(classify(withId({ maxLength: 10 }), withId({ maxLength: 10 })).bump, "patch")
  assert.equal(classify(withId({ maxLength: 100 }), withId({ maxLength: 10 })).changes[0]?.at, at)
})

test("reordering oneOf/anyOf members changes nothing; a changed member is still compared", () => {
  const variants = (key: string, members: ReadonlyArray<Schema.Json>) =>
    spec({ plan: plan((p) => ({ ...p, owner: { [key]: [...members] } })) })
  const text = { type: "string" }
  const count = { type: "integer" }
  const ref = { $ref: "#/components/schemas/NewPlan" }
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    assert.deepEqual(classify(variants(key, [text, count, ref]), variants(key, [ref, text, count])), {
      bump: "patch",
      changes: []
    })
  }
  assert.deepEqual(
    classify(variants("oneOf", [text, count]), variants("oneOf", [{ type: "boolean" }, text])).changes,
    [{
      level: "major",
      at: "#/components/schemas/Plan/properties/owner/oneOf/0",
      change: "type changed from integer to boolean"
    }]
  )
})

test("a property named like a documentation keyword is still a property", () => {
  const member = (properties: Record<string, Schema.Json>) => ({ type: "object", properties })
  const withVariant = (properties: Record<string, Schema.Json>) =>
    spec({ plan: plan((p) => ({ ...p, owner: { oneOf: [member(properties), { type: "string" }] } })) })
  const both = { description: { type: "string" }, labels: { type: "string" } }
  assert.equal(classify(withVariant(both), withVariant({ labels: { type: "string" } })).bump, "major")
  assert.equal(classify(withVariant(both), withVariant({ description: { type: "string" } })).bump, "major")
  // Editing a property's description text is documentation, not contract.
  assert.equal(
    classify(
      withVariant(both),
      withVariant({ ...both, description: { type: "string", description: "what the plan is for" } })
    ).bump,
    "patch"
  )

  const withResponse = (properties: Record<string, Schema.Json>) =>
    spec({
      responses: {
        Err: { description: "error", content: { "application/json": { schema: { type: "object", properties } } } }
      }
    })
  assert.equal(
    classify(
      withResponse({ title: { type: "string" }, code: { type: "integer" } }),
      withResponse({ code: { type: "integer" } })
    ).bump,
    "major"
  )
  assert.equal(
    classify(
      withResponse({ code: { type: "integer" } }),
      withResponse({ code: { type: "integer", description: "error code" } })
    ).bump,
    "patch"
  )
})

test("a retyped property named like a documentation keyword inside a composition member is major", () => {
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    for (const name of ["description", "title", "example"]) {
      const member = (type: string) => ({ type: "object", required: [name], properties: { [name]: { type } } })
      const withMember = (type: string) => spec({ plan: plan((p) => ({ ...p, owner: { [key]: [member(type)] } })) })
      assert.equal(classify(withMember("string"), withMember("integer")).bump, "major", `${key} ${name}`)
    }
  }
})

test("removing const is major: the generated literal type widens", () => {
  const withId = (id: Record<string, Schema.Json>) =>
    spec({ plan: plan((p) => ({ ...p, id: { type: "string", ...id } })) })
  assert.deepEqual(
    classify(withId({ const: "x" }), withId({})).changes.map((entry) => [entry.level, entry.change]),
    [["major", "const removed (was x)"]]
  )
  assert.equal(classify(withId({ const: "x" }), withId({ const: "x" })).bump, "patch")
  assert.equal(classify(withId({ maxLength: 5 }), withId({ maxLength: 50 })).bump, "minor")
})

// The notes become a changeset file, and CI runs `prettier --check .` over it.
test("release notes are already prettier-formatted markdown", async () => {
  const notes = releaseNotes({
    bump: "major",
    changes: [
      { level: "major", at: "#/components/schemas/Plan", change: "removed property note" },
      { level: "minor", at: "#/paths", change: "added path /kiosks" },
      { level: "minor", at: "#/paths", change: "added path /rooms" }
    ]
  }, 1)
  const config = await Prettier.resolveConfig(".changeset/release-notes.md")
  assert.equal(await Prettier.format(notes, { ...config, parser: "markdown" }), `${notes}\n`)
})
