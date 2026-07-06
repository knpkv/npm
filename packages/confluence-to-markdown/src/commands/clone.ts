/**
 * Clone command for Confluence CLI.
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { Command, Flag as Options, Prompt } from "effect/unstable/cli"
import { layer as AdfSchemaValidatorLayer } from "../AdfSchemaValidator.js"
import { layer as AtlaskitTransformersLayer } from "../AtlaskitTransformers.js"
import { PageId } from "../Brand.js"
import { type ConfluenceClientConfig, layer as ConfluenceClientLayer } from "../ConfluenceClient.js"
import { createConfigFile, layerFromValues as ConfluenceConfigLayerFromValues } from "../ConfluenceConfig.js"
import { ConfigError } from "../ConfluenceError.js"
import { GitService, layer as GitServiceLayer } from "../GitService.js"
import { writeStdout } from "../internal/stdio.js"
import { UserCacheLayer } from "../internal/userCache.js"
import { layer as LocalFileSystemLayer } from "../LocalFileSystem.js"
import { layer as MarkdownConverterLayer } from "../MarkdownConverter.js"
import { layer as SyncEngineLayer, SyncEngine } from "../SyncEngine.js"
import { resolvePageInput } from "./pageInput.js"
import { getAuth } from "./shared.js"

const ConverterPipeline = MarkdownConverterLayer.pipe(
  Layer.provide(AtlaskitTransformersLayer),
  Layer.provide(AdfSchemaValidatorLayer)
)

const rootPageIdOption = Options.string("root-page-id").pipe(
  Options.withDescription("Confluence root page ID to sync from"),
  Options.optional
)

const baseUrlOption = Options.string("base-url").pipe(
  Options.withDescription("Confluence Cloud base URL (e.g., https://yoursite.atlassian.net)"),
  Options.optional
)

const urlOption = Options.string("url").pipe(
  Options.withDescription("Confluence root page URL"),
  Options.optional
)

export const cloneCommand = Command.make(
  "clone",
  { rootPageId: rootPageIdOption, baseUrl: baseUrlOption, url: urlOption },
  ({ baseUrl, rootPageId, url: pageUrl }) =>
    Effect.gen(function*() {
      const urlInput = Option.isSome(pageUrl)
        ? yield* resolvePageInput({
          url: pageUrl.value,
          pageId: Option.isSome(rootPageId) ? rootPageId.value : undefined,
          baseUrl: Option.isSome(baseUrl) ? baseUrl.value : undefined
        })
        : undefined

      const git = yield* GitService

      // Fail if .confluence already exists
      const isGitInit = yield* git.isInitialized()
      if (isGitInit) {
        return yield* Effect.fail(
          new ConfigError({ message: "Already cloned. Use 'confluence sync pull' to update." })
        )
      }

      // Validate git is installed
      yield* Console.log("Checking git installation...")
      const gitVersion = yield* git.validateGit().pipe(
        Effect.mapError(() =>
          new ConfigError({ message: "Git is required but not installed. Please install git first." })
        )
      )
      yield* Console.log(`Found git ${gitVersion}`)

      const input = urlInput ??
        (yield* Effect.gen(function*() {
          const rawPageId = Option.isSome(rootPageId)
            ? rootPageId.value
            : yield* Prompt.text({ message: "Enter Confluence root page ID:" })
          const rawUrl = Option.isSome(baseUrl)
            ? baseUrl.value
            : yield* Prompt.text({ message: "Enter Confluence base URL (e.g., https://yoursite.atlassian.net):" })

          return yield* resolvePageInput({ pageId: rawPageId, baseUrl: rawUrl })
        }))

      const pageId = input.pageId
      const url = input.baseUrl

      const path = yield* createConfigFile(pageId, url)
      yield* Console.log(`Created configuration file: ${path}`)

      // Initialize git repo
      yield* Console.log("Initializing git repository...")
      yield* git.init().pipe(
        Effect.mapError(() => new ConfigError({ message: "Failed to initialize git repository" }))
      )

      // Build services dynamically with the new config
      yield* Console.log("Cloning pages from Confluence with full history...")

      // Get auth
      const auth = yield* getAuth()
      const clientConfig: ConfluenceClientConfig = { baseUrl: url, auth }

      // Build layers for the clone operation
      const configLayer = ConfluenceConfigLayerFromValues({
        rootPageId: PageId(pageId),
        baseUrl: url,
        docsPath: ".confluence/docs",
        excludePatterns: [],
        saveSource: false,
        trackedPaths: ["**/*.md"]
      })

      const clientLayer = ConfluenceClientLayer(clientConfig).pipe(
        Layer.provide(NodeHttpClient.layerFetch)
      )

      const cloneLayer = SyncEngineLayer.pipe(
        Layer.provideMerge(UserCacheLayer),
        Layer.provideMerge(GitServiceLayer),
        Layer.provideMerge(clientLayer),
        Layer.provideMerge(ConverterPipeline),
        Layer.provideMerge(LocalFileSystemLayer),
        Layer.provideMerge(configLayer),
        Layer.provideMerge(NodeServices.layer)
      )

      const result = yield* Effect.gen(function*() {
        const engine = yield* SyncEngine
        const gitService = yield* GitService
        const pullResult = yield* engine.pull({
          force: true,
          replayHistory: true,
          onProgress: (current, total, message) =>
            writeStdout(`\r  Replaying history: ${current}/${total} - ${message}`)
        })
        if (pullResult.errors.length > 0) {
          yield* writeStdout("\r" + " ".repeat(80) + "\r")
          return yield* Effect.fail(
            new ConfigError({ message: `Clone failed:\n${pullResult.errors.join("\n")}` })
          )
        }

        // Create origin/confluence branch at HEAD to track remote state
        yield* gitService.createBranch("origin/confluence")

        return pullResult
      }).pipe(Effect.provide(cloneLayer))

      // Clear progress line and print final result
      yield* writeStdout("\r" + " ".repeat(80) + "\r")
      yield* Console.log(`Cloned ${result.pulled} pages with ${result.commits} commits`)
    })
).pipe(Command.withDescription("Local write: clone Confluence pages with full version history"))
