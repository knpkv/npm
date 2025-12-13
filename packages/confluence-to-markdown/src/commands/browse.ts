/**
 * Browse command - interactive TUI for navigating Confluence pages.
 */
import { Command } from "@effect/cli"
import { Components, RendererError, RendererLive } from "@knpkv/effect-opentui"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import type { PageId } from "../Brand.js"
import { ConfluenceClient } from "../ConfluenceClient.js"
import { ConfluenceConfig } from "../ConfluenceConfig.js"
import type { ApiError, ConversionError, RateLimitError } from "../ConfluenceError.js"
import { MarkdownConverter } from "../MarkdownConverter.js"
import { SyncEngine } from "../SyncEngine.js"

/**
 * Item type for browse navigation.
 */
interface BrowseItem {
  readonly id: PageId
  readonly title: string
  readonly hasChildren: boolean
}

type BrowseError = ApiError | RateLimitError | ConversionError

/**
 * Maps errors to RendererError for MillerColumns.
 */
const mapError = (error: BrowseError): RendererError => new RendererError({ reason: error.message })

/**
 * Browse command implementation.
 */
export const browseCommand = Command.make("browse", {}, () =>
  Effect.gen(function*() {
    const client = yield* ConfluenceClient
    const config = yield* ConfluenceConfig
    const converter = yield* MarkdownConverter
    const syncEngine = yield* SyncEngine

    // Get root page info
    const rootPage = yield* client.getPage(config.rootPageId).pipe(Effect.mapError(mapError))

    const rootItem: BrowseItem = {
      id: config.rootPageId,
      title: rootPage.title,
      hasChildren: true
    }

    // Fetch children for a page
    const getChildren = (item: BrowseItem): Effect.Effect<ReadonlyArray<BrowseItem>, RendererError> =>
      client.getAllChildren(item.id).pipe(
        Effect.map((children) =>
          children.map((child): BrowseItem => ({
            id: child.id as PageId,
            title: child.title,
            hasChildren: true
          }))
        ),
        Effect.mapError(mapError)
      )

    // Get preview content (markdown)
    const getPreview = (item: BrowseItem): Effect.Effect<string, RendererError> =>
      client.getPage(item.id).pipe(
        Effect.flatMap((page) => {
          const html = page.body?.storage?.value ?? ""
          return converter.htmlToMarkdown(html)
        }),
        Effect.mapError(mapError)
      )

    // Action handlers
    const actions: Record<string, (item: BrowseItem) => Effect.Effect<void, RendererError>> = {
      c: (_item) =>
        Effect.gen(function*() {
          yield* Console.log("\nPulling pages...")
          yield* syncEngine.pull({ force: false }).pipe(
            Effect.mapError((e) => new RendererError({ reason: `Pull failed: ${e.message}` }))
          )
          yield* Console.log("Done!")
        }),
      p: (_item) =>
        Effect.gen(function*() {
          yield* Console.log("\nPulling pages...")
          yield* syncEngine.pull({ force: false }).pipe(
            Effect.mapError((e) => new RendererError({ reason: `Pull failed: ${e.message}` }))
          )
          yield* Console.log("Done!")
        }),
      P: (_item) =>
        Effect.gen(function*() {
          yield* Console.log("\nPushing changes...")
          yield* syncEngine.push({ dryRun: false }).pipe(
            Effect.mapError((e) => new RendererError({ reason: `Push failed: ${e.message}` }))
          )
          yield* Console.log("Done!")
        })
    }

    const millerConfig: Components.MillerColumnsConfig<BrowseItem> = {
      columns: [
        { id: "root", renderItem: (item: BrowseItem) => item.title, getChildren },
        { id: "children", renderItem: (item: BrowseItem) => item.title, getChildren },
        { id: "grandchildren", renderItem: (item: BrowseItem) => item.title, getChildren }
      ],
      initialItems: Effect.succeed([rootItem]),
      preview: getPreview,
      actions,
      onQuit: Console.log("\nGoodbye!")
    }

    yield* Components.MillerColumns(millerConfig).pipe(
      Effect.provide(RendererLive),
      Effect.catchAll((e: RendererError) => Console.error(`Error: ${e.reason}`))
    )
  })).pipe(Command.withDescription("Browse Confluence pages interactively (TUI)"))
