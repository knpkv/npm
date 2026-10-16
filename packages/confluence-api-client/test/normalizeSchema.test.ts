import * as OpenApiGenerator from "@effect/openapi-generator/OpenApiGenerator"
import { describe, expect, it, layer } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type { OpenAPISpec } from "effect/http-api/OpenApi"
import { normalizeSchema } from "../scripts/normalizeSchema.js"

// The pattern Confluence v2 added on 2026-10-15; its `/` broke every regenerate.
const upstreamPattern = "^/wiki/api/v2/databases/"

const documentWithPattern = (pattern: string): OpenAPISpec => ({
  openapi: "3.1.0",
  info: { title: "Pattern fixture", version: "1.0.0" },
  paths: {
    "/links": {
      get: {
        operationId: "getLinks",
        parameters: [],
        tags: ["Links"],
        security: [],
        responses: {
          "200": {
            description: "Links",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Links" } } }
          }
        }
      }
    }
  },
  components: {
    schemas: {
      Links: {
        type: "object",
        required: ["self"],
        properties: { self: { type: "string", pattern } }
      }
    },
    securitySchemes: {}
  },
  security: [],
  tags: []
})

const generate = (onEnter?: typeof normalizeSchema) =>
  Effect.gen(function*() {
    const generator = yield* OpenApiGenerator.OpenApiGenerator
    const options: OpenApiGenerator.OpenApiGenerateOptions = { name: "PatternApi", format: "httpclient" }
    return yield* generator.generate(
      documentWithPattern(upstreamPattern),
      onEnter === undefined ? options : { ...options, onEnter }
    )
  })

layer(OpenApiGenerator.layerTransformerSchema)("generating a slash pattern", (it) => {
  it.effect("the generator rejects a slash pattern as published", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(generate())
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("Invalid representation payload for effect/schema/isPattern")
      }
    }))

  it.effect("a normalized slash pattern generates", () =>
    Effect.gen(function*() {
      const source = yield* generate(normalizeSchema)
      const escaped = new RegExp(upstreamPattern, "u").source
      expect(source).toContain(`Schema.isPattern(new RegExp(${JSON.stringify(escaped)}, "u"))`)
    }))
})

describe("normalizeSchema", () => {
  it("the rewritten pattern matches exactly what the published one does", () => {
    const normalized = normalizeSchema({ type: "string", pattern: upstreamPattern })
    const published = new RegExp(upstreamPattern, "u")
    const rewritten = new RegExp(String(normalized.pattern), "u")
    for (const candidate of ["/wiki/api/v2/databases/1", "/wiki/api/v2/databases/", "/wiki/api/v2/pages/1", "x/wiki"]) {
      expect(rewritten.test(candidate)).toBe(published.test(candidate))
    }
  })

  it("keeps nullable and metadata handling", () => {
    expect(normalizeSchema({ type: "string", nullable: true, default: "x", examples: ["y"] })).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }]
    })
    expect(normalizeSchema({ type: "string", pattern: "^[a-z]+$" })).toEqual({ type: "string", pattern: "^[a-z]+$" })
  })
})
