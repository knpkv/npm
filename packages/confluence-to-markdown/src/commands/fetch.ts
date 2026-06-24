/**
 * Fetch command for Confluence CLI.
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { Command, Flag as Options } from "effect/unstable/cli"
import type { PageId } from "../Brand.js"
import { ConfluenceClient, type ConfluenceClientConfig, layer as ConfluenceClientLayer } from "../ConfluenceClient.js"
import { ConfigError } from "../ConfluenceError.js"
import { cleanMarkdown as removeRoundTripMetadata } from "../internal/cleanMarkdown.js"
import { writeStdout } from "../internal/stdio.js"
import { MarkdownConverter } from "../MarkdownConverter.js"
import { resolvePageInput } from "./pageInput.js"
import { getAuth } from "./shared.js"

const urlOption = Options.string("url").pipe(
  Options.withDescription("Confluence page URL"),
  Options.optional
)

const pageIdOption = Options.string("page-id").pipe(
  Options.withDescription("Confluence page ID"),
  Options.optional
)

const baseUrlOption = Options.string("base-url").pipe(
  Options.withDescription("Confluence Cloud base URL (e.g., https://yoursite.atlassian.net)"),
  Options.optional
)

const cleanMarkdownOption = Options.boolean("clean-markdown").pipe(
  Options.withDescription("Print readable markdown without Confluence round-trip metadata")
)

export const fetchPageMarkdown = (
  pageId: PageId,
  options: { readonly cleanMarkdown: boolean }
) =>
  Effect.gen(function*() {
    const client = yield* ConfluenceClient
    const converter = yield* MarkdownConverter
    const page = yield* client.getPage(pageId)
    const adfJson = page.body?.atlas_doc_format?.value

    if (!adfJson) {
      return yield* Effect.fail(new ConfigError({ message: `Page ${pageId} did not include ADF content.` }))
    }

    const markdown = yield* converter.adfToMarkdown(adfJson)
    return options.cleanMarkdown ? removeRoundTripMetadata(markdown) : markdown
  })

const optionValue = (option: Option.Option<string>): string | undefined =>
  Option.isSome(option) ? option.value : undefined

export interface FetchCommandOptions {
  readonly makeClientLayer?: (config: ConfluenceClientConfig) => Layer.Layer<ConfluenceClient>
}

export const makeFetchCommand = (options: FetchCommandOptions = {}) => {
  const makeClientLayer = options.makeClientLayer ??
    ((clientConfig: ConfluenceClientConfig) =>
      ConfluenceClientLayer(clientConfig).pipe(
        Layer.provide(NodeHttpClient.layerFetch)
      ))

  return Command.make(
    "fetch",
    { url: urlOption, pageId: pageIdOption, baseUrl: baseUrlOption, cleanMarkdown: cleanMarkdownOption },
    ({ baseUrl, cleanMarkdown, pageId, url }) =>
      Effect.gen(function*() {
        const input = yield* resolvePageInput({
          url: optionValue(url),
          pageId: optionValue(pageId),
          baseUrl: optionValue(baseUrl)
        })
        const auth = yield* getAuth()
        const clientConfig: ConfluenceClientConfig = { baseUrl: input.baseUrl, auth }
        const markdown = yield* fetchPageMarkdown(input.pageId as PageId, { cleanMarkdown }).pipe(
          Effect.provide(makeClientLayer(clientConfig))
        )

        yield* writeStdout(markdown.endsWith("\n") ? markdown : `${markdown}\n`)
      })
  ).pipe(Command.withDescription("Fetch the latest Confluence page markdown without creating a git workspace"))
}

export const fetchCommand = makeFetchCommand()
