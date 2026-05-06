/**
 * ADF ↔ Markdown conversion facade.
 *
 * Push (markdown → ADF) routes through the official `@atlaskit` markdown
 * + JSON transformers. Pull (ADF → markdown) routes through the in-package
 * `AdfWalker`. Both paths run through `AdfSchemaValidator`, so library bugs
 * and remote drift surface as structured errors instead of silent corruption.
 *
 * @module
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
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
export class MarkdownConverter extends Context.Tag(
  "@knpkv/confluence-to-markdown/MarkdownConverter"
)<
  MarkdownConverter,
  {
    /**
     * Convert an ADF JSON document (as wire-format string) to GitHub Flavored
     * Markdown. Validates against the canonical @atlaskit/adf-schema before
     * walking.
     */
    readonly adfToMarkdown: (adfJson: string) => Effect.Effect<string, ConversionError>

    /**
     * Convert GitHub Flavored Markdown to a JSON-stringified ADF document.
     * Routes through the official @atlaskit transformers; validates the
     * produced ADF against the canonical schema before stringification.
     */
    readonly markdownToAdf: (markdown: string) => Effect.Effect<string, ConversionError>
  }
>() {}

const warningSummary = (w: WalkerWarning): string => {
  switch (w._tag) {
    case "UnsupportedNode":
      return `${w._tag} ${w.nodeType}`
    case "LossyMark":
      return `${w._tag} ${w.mark}`
    case "MediaWithoutUrl":
      return `${w._tag} ${w.mediaId}`
  }
}

const toConversionError = (
  direction: "adfToMarkdown" | "markdownToAdf"
) =>
(cause: AdfSchemaError | AtlaskitTransformersError | { readonly cause: unknown }): ConversionError =>
  new ConversionError({ direction, cause })

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
        const doc = yield* validator.check(raw, "incoming").pipe(
          Effect.mapError(toConversionError("adfToMarkdown"))
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
        const validated = yield* validator.check(adf, "outgoing").pipe(
          Effect.mapError(toConversionError("markdownToAdf"))
        )
        return JSON.stringify(validated)
      })

    return MarkdownConverter.of({ adfToMarkdown, markdownToAdf })
  })
)
