/**
 * Runtime JSON-Schema validator for ADF documents.
 *
 * Wraps Ajv compiled against the canonical schema bundled in
 * `@atlaskit/adf-schema` (`json-schema/v1/full.json`). Used on both
 * directions of the conversion: incoming (after `JSON.parse`, before walking)
 * and outgoing (after the @atlaskit transformer produces JSON, before
 * `JSON.stringify`). The single project-wide cast `as DocNode` lives here,
 * bridging Ajv's runtime predicate to the TypeScript types.
 *
 * @module
 */
import type { DocNode } from "@atlaskit/adf-schema"
import adfJsonSchema from "@atlaskit/adf-schema/json-schema/v1/full.json" with { type: "json" }
import Ajv from "ajv-draft-04"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { AdfSchemaError, type AdfSchemaIssue } from "./ConfluenceError.js"

const ajv = new Ajv({ strict: false, allErrors: true })
const validate = ajv.compile<DocNode>(adfJsonSchema)

/**
 * Effect service that runtime-validates ADF documents against the canonical
 * @atlaskit/adf-schema JSON Schema and narrows the success type to `DocNode`.
 *
 * @category Service
 */
export class AdfSchemaValidator extends Context.Service<
  AdfSchemaValidator,
  {
    readonly check: (
      doc: unknown,
      direction: "incoming" | "outgoing"
    ) => Effect.Effect<DocNode, AdfSchemaError>
  }
>()("@knpkv/confluence-to-markdown/AdfSchemaValidator") {}

/**
 * Live Layer for `AdfSchemaValidator`. The Ajv validator is compiled once at
 * module load.
 *
 * @category Layers
 */
export const layer: Layer.Layer<AdfSchemaValidator> = Layer.succeed(
  AdfSchemaValidator,
  AdfSchemaValidator.of({
    check: (doc, direction) =>
      validate(doc)
        ? Effect.succeed(doc)
        : Effect.fail(
          new AdfSchemaError({
            direction,
            issues: (validate.errors ?? []).map((e): AdfSchemaIssue => ({
              instancePath: e.instancePath,
              schemaPath: e.schemaPath,
              keyword: e.keyword,
              params: e.params,
              ...(e.message !== undefined ? { message: e.message } : {})
            }))
          })
        )
  })
)
