/**
 * Effect wrapper around the official @atlaskit markdown / JSON transformers.
 *
 * Push direction (markdown → ADF) routes through `MarkdownTransformer.parse()`
 * (markdown → ProseMirror node) followed by `JSONTransformer.encode()`
 * (ProseMirror node → ADF JSON). Both libraries are stateless once
 * constructed, so we instantiate them once at module load.
 *
 * @module
 */
import { defaultSchema } from "@atlaskit/adf-schema/schema-default"
import { type JSONDocNode, JSONTransformer } from "@atlaskit/editor-json-transformer"
import { MarkdownTransformer } from "@atlaskit/editor-markdown-transformer"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { AtlaskitTransformersError } from "./ConfluenceError.js"

/**
 * Bag of the two transformer instances handed to the `use` callback.
 */
export interface Transformers {
  readonly md: MarkdownTransformer
  readonly json: JSONTransformer
}

const md = new MarkdownTransformer(defaultSchema)
const json = new JSONTransformer(defaultSchema)
const transformers: Transformers = { md, json }

/**
 * Effect service exposing the @atlaskit markdown + JSON transformers via a
 * `use` callback. Errors thrown synchronously by the underlying libraries are
 * surfaced as `AtlaskitTransformersError`.
 *
 * @category Service
 */
export class AtlaskitTransformers extends Context.Tag(
  "@knpkv/confluence-to-markdown/AtlaskitTransformers"
)<
  AtlaskitTransformers,
  {
    readonly use: <A>(
      fn: (t: Transformers) => A
    ) => Effect.Effect<A, AtlaskitTransformersError>
  }
>() {}

/**
 * Live Layer providing the wrapped @atlaskit transformers. The transformer
 * instances are module-level singletons; the layer just hands out a
 * `use`-callback service that catches synchronous throws.
 *
 * @category Layers
 */
export const layer: Layer.Layer<AtlaskitTransformers> = Layer.succeed(
  AtlaskitTransformers,
  AtlaskitTransformers.of({
    use: <A>(fn: (t: Transformers) => A) =>
      Effect.try({
        try: () => fn(transformers),
        catch: (cause) => new AtlaskitTransformersError({ cause })
      })
  })
)

export type { JSONDocNode }
