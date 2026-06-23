/**
 * ADF ↔ Markdown conversion facade.
 *
 * Push (markdown → ADF) routes through the official `@atlaskit` markdown
 * + JSON transformers and is strictly validated by `AdfSchemaValidator` —
 * we author that side, so schema failures are bugs. Pull (ADF → markdown)
 * routes through the in-package `AdfWalker`; incoming validation is advisory
 * (logged, not thrown) because Confluence Cloud routinely emits documents the
 * canonical schema lags behind.
 *
 * @module
 */
import type { DocNode } from "@atlaskit/adf-schema"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { revertPlaceholders } from "./AdfPlaceholders.js"
import { AdfSchemaValidator } from "./AdfSchemaValidator.js"
import { walk, type WalkerWarning } from "./AdfWalker.js"
import { AtlaskitTransformers } from "./AtlaskitTransformers.js"
import type { AdfSchemaError, AtlaskitTransformersError } from "./ConfluenceError.js"
import { ConversionError } from "./ConfluenceError.js"

/**
 * Markdown conversion service. Public surface is two delegating methods —
 * `adfToMarkdown` (pull) and `markdownToAdf` (push).
 *
 * @example
 * ```typescript
 * import { MarkdownConverter } from "@knpkv/confluence-to-markdown/MarkdownConverter"
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function* () {
 *   const converter = yield* MarkdownConverter
 *   const md = yield* converter.adfToMarkdown(adfJson)
 * })
 * ```
 *
 * @category Conversion
 */
export class MarkdownConverter extends Context.Service<
  MarkdownConverter,
  {
    /**
     * Convert an ADF JSON document (as wire-format string) to GitHub Flavored
     * Markdown. Checks against the canonical @atlaskit/adf-schema before
     * walking; violations are logged as warnings (remote drift), and only a
     * document too malformed to walk at all fails with ConversionError.
     */
    readonly adfToMarkdown: (adfJson: string) => Effect.Effect<string, ConversionError>

    /**
     * Convert GitHub Flavored Markdown to a JSON-stringified ADF document.
     * Routes through the official @atlaskit transformers; validates the
     * produced ADF against the canonical schema before stringification.
     */
    readonly markdownToAdf: (markdown: string) => Effect.Effect<string, ConversionError>
  }
>()("@knpkv/confluence-to-markdown/MarkdownConverter") {}

const warningSummary = (w: WalkerWarning): string => {
  switch (w._tag) {
    case "UnsupportedNode":
      return `${w._tag} ${w.nodeType}`
    case "LossyMark":
      return `${w._tag} ${w.mark}`
    case "MediaWithoutUrl":
      return `${w._tag} ${w.mediaId}`
    case "UnsupportedExtension":
      return `${w._tag} ${w.nodeType} ${w.extensionKey || "?"}`
  }
}

const toConversionError = (
  direction: "adfToMarkdown" | "markdownToAdf"
) =>
(cause: AdfSchemaError | AtlaskitTransformersError | { readonly cause: unknown }): ConversionError =>
  new ConversionError({ direction, cause })

// The least structure the walker needs: a doc node with a content array.
// Anything failing this isn't "schema drift", it's not an ADF document —
// advisory validation must not let it through (walking `null` is a defect;
// walking `{}` silently produces an empty page).
const isWalkableDoc = Schema.is(Schema.Struct({
  type: Schema.Literal("doc"),
  content: Schema.Array(Schema.Unknown)
}))

/**
 * Layer that provides the MarkdownConverter service.
 *
 * @category Layers
 */
export const layer: Layer.Layer<
  MarkdownConverter,
  never,
  AtlaskitTransformers | AdfSchemaValidator
> = Layer.effect(
  MarkdownConverter,
  Effect.gen(function*() {
    const transformers = yield* AtlaskitTransformers
    const validator = yield* AdfSchemaValidator

    const adfToMarkdown = (adfJson: string): Effect.Effect<string, ConversionError> =>
      Effect.gen(function*() {
        const raw = yield* Effect.try({
          try: () => JSON.parse(adfJson),
          catch: (cause) => new ConversionError({ direction: "adfToMarkdown", cause })
        })
        // Incoming validation is advisory: the canonical @atlaskit schema is
        // routinely stricter than what Confluence Cloud actually emits (old
        // revisions, experimental nodes), so a failure here usually means
        // "schema drift", not "broken document". Log + continue. Outgoing
        // validation stays strict because we control that side.
        const doc = yield* validator.check(raw, "incoming").pipe(
          Effect.catchTag("AdfSchemaError", (err) =>
            isWalkableDoc(raw)
              ? Effect.gen(function*() {
                yield* Effect.logWarning(
                  `adf schema (incoming): ${err.issues.length} issue(s); first: ${
                    err.issues.slice(0, 3).map((i) =>
                      `${i.instancePath ?? "?"} ${i.keyword ?? "?"} ${i.message ?? ""}`.trim()
                    ).join(" | ")
                  }`
                )
                return raw as DocNode
              })
              : Effect.fail(toConversionError("adfToMarkdown")(err)))
        )
        const { markdown, warnings } = walk(doc)
        for (const w of warnings) {
          yield* Effect.logWarning(`adf walker: ${warningSummary(w)}`, w)
        }
        return markdown
      })

    const markdownToAdf = (markdown: string): Effect.Effect<string, ConversionError> =>
      Effect.gen(function*() {
        const adf = yield* transformers.use(({ json, md }) => json.encode(md.parse(markdown))).pipe(
          Effect.mapError(toConversionError("markdownToAdf"))
        )
        // The walker emits HTML/comment placeholders for Confluence-only nodes
        // (status, extension). @atlaskit's markdown transformer doesn't know
        // these, so they come through as plain text. Rewrite them back into
        // the structured nodes Confluence expects before validation.
        const reverted = revertPlaceholders(adf)
        const validated = yield* validator.check(reverted, "outgoing").pipe(
          Effect.mapError(toConversionError("markdownToAdf"))
        )
        return JSON.stringify(validated)
      })

    return MarkdownConverter.of({ adfToMarkdown, markdownToAdf })
  })
)
