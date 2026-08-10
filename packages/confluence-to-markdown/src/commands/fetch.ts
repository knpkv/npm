/**
 * Fetch command for Confluence CLI.
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { Command, Flag as Options } from "effect/unstable/cli"
import { PageId } from "../Brand.js"
import { ConfluenceClient, type ConfluenceClientConfig, layer as ConfluenceClientLayer } from "../ConfluenceClient.js"
import { ConfigError } from "../ConfluenceError.js"
import { cleanMarkdown as removeRoundTripMetadata } from "../internal/cleanMarkdown.js"
import { writeStderr, writeStdout } from "../internal/stdio.js"
import { MarkdownConverter } from "../MarkdownConverter.js"
import { resolvePageInputWithWorkspace } from "./pageInput.js"
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

// `choice` rather than a free-form string plus a runtime `if`: the accepted
// values then show up in `page get --help` and in completion, and `--format
// json` is rejected by the parser instead of after argument resolution.
const formatOption = Options.choice("format", ["md", "adf"]).pipe(
  Options.withDescription("Output format: md (default) or adf for the raw Atlassian Document Format JSON"),
  Options.withDefault("md")
)

/**
 * Fetch a page's stored ADF document.
 *
 * The markdown projection is lossy for some node types (datasource cards,
 * extensions), so anything that needs to edit and write a page back
 * faithfully should round-trip through this instead.
 */
export const fetchPageAdf = (pageId: PageId) =>
  Effect.gen(function*() {
    const client = yield* ConfluenceClient
    const page = yield* client.getPage(pageId)
    const adfJson = page.body?.atlas_doc_format?.value

    if (!adfJson) {
      return yield* Effect.fail(new ConfigError({ message: `Page ${pageId} did not include ADF content.` }))
    }

    return { adfJson, version: page.version.number }
  })

export const fetchPageMarkdown = (
  pageId: PageId,
  options: { readonly cleanMarkdown: boolean }
) =>
  Effect.gen(function*() {
    const converter = yield* MarkdownConverter
    const { adfJson } = yield* fetchPageAdf(pageId)
    const markdown = yield* converter.adfToMarkdown(adfJson)
    return options.cleanMarkdown ? removeRoundTripMetadata(markdown) : markdown
  })

const optionValue = (option: Option.Option<string>): string | undefined =>
  Option.isSome(option) ? option.value : undefined

export interface FetchCommandOptions {
  readonly name?: string
  readonly makeClientLayer?: (config: ConfluenceClientConfig) => Layer.Layer<ConfluenceClient>
}

export const makeFetchCommand = (options: FetchCommandOptions = {}) => {
  const makeClientLayer = options.makeClientLayer ??
    ((clientConfig: ConfluenceClientConfig) =>
      ConfluenceClientLayer(clientConfig).pipe(
        Layer.provide(NodeHttpClient.layerFetch)
      ))

  return Command.make(
    options.name ?? "fetch",
    {
      url: urlOption,
      pageId: pageIdOption,
      baseUrl: baseUrlOption,
      cleanMarkdown: cleanMarkdownOption,
      format: formatOption
    },
    ({ baseUrl, cleanMarkdown, format, pageId, url }) =>
      Effect.gen(function*() {
        // --clean-markdown only reaches the markdown branch. Accepting it
        // beside --format adf and dropping it silently hands back raw ADF to
        // someone who asked for cleaned output.
        if (format === "adf" && cleanMarkdown) {
          return yield* Effect.fail(
            new ConfigError({ message: "--clean-markdown applies to --format md; it has no effect on raw ADF." })
          )
        }

        const input = yield* resolvePageInputWithWorkspace({
          url: optionValue(url),
          pageId: optionValue(pageId),
          baseUrl: optionValue(baseUrl)
        })
        const auth = yield* getAuth()
        const clientConfig: ConfluenceClientConfig = { baseUrl: input.baseUrl, auth }
        const clientLayer = makeClientLayer(clientConfig)
        // Only the ADF path reports a version; markdown is not a body you feed
        // back to `page put`.
        const noVersion: number | undefined = undefined
        const fetched = yield* (format === "adf"
          ? fetchPageAdf(PageId(input.pageId)).pipe(
            // Pretty-printing means parsing, and a stored body that is not JSON
            // is bad input, not a bug — keep it in the typed error channel
            // rather than letting it escape as a defect with a stack trace.
            Effect.flatMap(({ adfJson, version }) =>
              Effect.try({
                try: () => ({ output: JSON.stringify(JSON.parse(adfJson), null, 2), version }),
                catch: () => new ConfigError({ message: `Page ${input.pageId} stored a body that is not valid JSON.` })
              })
            ),
            Effect.provide(clientLayer)
          )
          : fetchPageMarkdown(PageId(input.pageId), { cleanMarkdown }).pipe(
            Effect.map((output) => ({ output, version: noVersion })),
            Effect.provide(clientLayer)
          ))

        // On stderr, so stdout stays the machine-readable document while the
        // read-modify-write workflow still has the number `page put
        // --if-version` needs. Without this the safe form of that workflow
        // could not be performed at all.
        if (fetched.version !== undefined) {
          yield* writeStderr(`Read page ${input.pageId} at version ${fetched.version}.\n`)
        }
        yield* writeStdout(fetched.output.endsWith("\n") ? fetched.output : `${fetched.output}\n`)
      })
  ).pipe(
    Command.withDescription("Read-only: fetch the latest Confluence page markdown without creating a git workspace")
  )
}

export const fetchCommand = makeFetchCommand()
export const pageGetCommand = makeFetchCommand({ name: "get" })
