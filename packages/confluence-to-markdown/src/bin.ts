#!/usr/bin/env node
/**
 * CLI entry point for confluence-to-markdown.
 */
import { Command, Options, Prompt } from "@effect/cli"
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeTerminal from "@effect/platform-node/NodeTerminal"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import pkg from "../package.json" with { type: "json" }
import type { PageId } from "./Brand.js"
import { ConfluenceClient, type ConfluenceClientConfig, layer as ConfluenceClientLayer } from "./ConfluenceClient.js"
import {
  ConfluenceConfig,
  createConfigFile,
  layer as ConfluenceConfigLayer,
  layerFromValues as ConfluenceConfigLayerFromValues
} from "./ConfluenceConfig.js"
import { AuthMissingError, ConfigError } from "./ConfluenceError.js"
import { layer as LocalFileSystemLayer } from "./LocalFileSystem.js"
import { layer as MarkdownConverterLayer } from "./MarkdownConverter.js"
import { layer as SyncEngineLayer, SyncEngine } from "./SyncEngine.js"

// === Auth config ===
const AuthConfig = Config.all({
  apiKey: Config.string("CONFLUENCE_API_KEY"),
  email: Config.string("CONFLUENCE_EMAIL")
})

const getAuth = (): Effect.Effect<ConfluenceClientConfig["auth"], AuthMissingError> =>
  AuthConfig.pipe(
    Effect.map(({ apiKey, email }) => ({ type: "token" as const, email, token: apiKey })),
    Effect.mapError(() => new AuthMissingError())
  )

// === Init command ===
const rootPageIdOption = Options.text("root-page-id").pipe(
  Options.withDescription("Confluence root page ID to sync from"),
  Options.optional
)
const baseUrlOption = Options.text("base-url").pipe(
  Options.withDescription("Confluence Cloud base URL (e.g., https://yoursite.atlassian.net)"),
  Options.optional
)

/** Validate page ID format */
const validatePageId = (input: string): Effect.Effect<string, ConfigError> =>
  input.trim().length > 0
    ? Effect.succeed(input.trim())
    : Effect.fail(new ConfigError({ message: "Page ID cannot be empty" }))

/** Validate base URL format */
const validateBaseUrl = (input: string): Effect.Effect<string, ConfigError> => {
  const pattern = /^https:\/\/[a-z0-9-]+\.atlassian\.net$/
  return pattern.test(input)
    ? Effect.succeed(input)
    : Effect.fail(
      new ConfigError({
        message: `Invalid Confluence URL: ${input}. Expected format: https://yoursite.atlassian.net`
      })
    )
}

const initCommand = Command.make(
  "init",
  { rootPageId: rootPageIdOption, baseUrl: baseUrlOption },
  ({ baseUrl, rootPageId }) =>
    Effect.gen(function*() {
      const rawPageId = Option.isSome(rootPageId)
        ? rootPageId.value
        : yield* Prompt.text({ message: "Enter Confluence root page ID:" })
      const rawUrl = Option.isSome(baseUrl)
        ? baseUrl.value
        : yield* Prompt.text({ message: "Enter Confluence base URL (e.g., https://yoursite.atlassian.net):" })

      const pageId = yield* validatePageId(rawPageId)
      const url = yield* validateBaseUrl(rawUrl)

      const path = yield* createConfigFile(pageId, url)
      yield* Console.log(`Created configuration file: ${path}`)
    })
).pipe(Command.withDescription("Initialize .confluence.json configuration"))

// === Pull command ===
const forceOption = Options.boolean("force").pipe(
  Options.withAlias("f"),
  Options.withDescription("Overwrite local changes")
)

const pullCommand = Command.make("pull", { force: forceOption }, ({ force }) =>
  Effect.gen(function*() {
    const engine = yield* SyncEngine
    yield* Console.log("Pulling pages from Confluence...")
    const result = yield* engine.pull({ force })
    yield* Console.log(`Pulled ${result.pulled} pages`)
    if (result.errors.length > 0) {
      yield* Console.error("Errors:", result.errors.join("\n"))
    }
  })).pipe(Command.withDescription("Download pages from Confluence to local markdown"))

// === Push command ===
const dryRunOption = Options.boolean("dry-run").pipe(
  Options.withAlias("n"),
  Options.withDescription("Show changes without applying")
)

const pushCommand = Command.make("push", { dryRun: dryRunOption }, ({ dryRun }) =>
  Effect.gen(function*() {
    const engine = yield* SyncEngine
    yield* Console.log(dryRun ? "Dry run - showing changes..." : "Pushing changes to Confluence...")
    const result = yield* engine.push({ dryRun })
    yield* Console.log(`Pushed: ${result.pushed}, Created: ${result.created}, Skipped: ${result.skipped}`)
    if (result.errors.length > 0) {
      yield* Console.error("Errors:", result.errors.join("\n"))
    }
  })).pipe(Command.withDescription("Upload local markdown changes to Confluence"))

// === Sync command ===
const syncCommand = Command.make("sync", {}, () =>
  Effect.gen(function*() {
    const engine = yield* SyncEngine
    yield* Console.log("Syncing with Confluence...")
    const result = yield* engine.sync()
    yield* Console.log(`Pulled: ${result.pulled}, Pushed: ${result.pushed}, Created: ${result.created}`)
    if (result.conflicts > 0) {
      yield* Console.warn(`Conflicts: ${result.conflicts}`)
    }
    if (result.errors.length > 0) {
      yield* Console.error("Errors:", result.errors.join("\n"))
    }
  })).pipe(Command.withDescription("Bidirectional sync with conflict detection"))

// === Status command ===
const statusCommand = Command.make("status", {}, () =>
  Effect.gen(function*() {
    const engine = yield* SyncEngine
    const result = yield* engine.status()
    yield* Console.log(`
Sync Status:
  Synced:          ${result.synced}
  Local Modified:  ${result.localModified}
  Remote Modified: ${result.remoteModified}
  Conflicts:       ${result.conflicts}
  Local Only:      ${result.localOnly}
  Remote Only:     ${result.remoteOnly}
`)
    if (result.files.length > 0 && result.synced < result.files.length) {
      yield* Console.log("Changed files:")
      for (const file of result.files) {
        if (file._tag !== "Synced" && file._tag !== "RemoteOnly") {
          yield* Console.log(`  [${file._tag}] ${file.path}`)
        } else if (file._tag === "RemoteOnly") {
          yield* Console.log(`  [${file._tag}] ${file.page.title}`)
        }
      }
    }
  })).pipe(Command.withDescription("Show sync status"))

// === Main command ===
const confluence = Command.make("confluence").pipe(
  Command.withDescription("Sync Confluence pages to local markdown"),
  Command.withSubcommands([initCommand, pullCommand, pushCommand, syncCommand, statusCommand])
)

// === Build app layer ===
// Dummy config layer for help/init
const DummyConfigLayer = ConfluenceConfigLayerFromValues({
  rootPageId: "dummy" as PageId,
  baseUrl: "https://dummy.atlassian.net",
  docsPath: ".docs/confluence",
  excludePatterns: []
})

// Dummy client layer for help/init (will fail if actually used)
const DummyConfluenceClientLayer = Layer.succeed(
  ConfluenceClient,
  ConfluenceClient.of({
    getPage: () => Effect.dieMessage("Not configured"),
    getChildren: () => Effect.dieMessage("Not configured"),
    getAllChildren: () => Effect.dieMessage("Not configured"),
    createPage: () => Effect.dieMessage("Not configured"),
    updatePage: () => Effect.dieMessage("Not configured"),
    deletePage: () => Effect.dieMessage("Not configured")
  })
)

// Dummy sync engine that will fail if actually used
const DummySyncEngineLayer = Layer.succeed(
  SyncEngine,
  SyncEngine.of({
    pull: () => Effect.dieMessage("Not configured - run 'confluence init' first"),
    push: () => Effect.dieMessage("Not configured - run 'confluence init' first"),
    sync: () => Effect.dieMessage("Not configured - run 'confluence init' first"),
    status: () => Effect.dieMessage("Not configured - run 'confluence init' first")
  })
)

// Build client layer dynamically based on auth
const ConfluenceClientLive = Layer.unwrapEffect(
  Effect.gen(function*() {
    const auth = yield* getAuth()
    const config = yield* ConfluenceConfig

    const clientConfig: ConfluenceClientConfig = {
      baseUrl: config.baseUrl,
      auth
    }

    return ConfluenceClientLayer(clientConfig)
  })
)

// Full app layer with all services
const AppLayer = SyncEngineLayer.pipe(
  Layer.provideMerge(ConfluenceClientLive),
  Layer.provideMerge(MarkdownConverterLayer),
  Layer.provideMerge(LocalFileSystemLayer),
  Layer.provideMerge(ConfluenceConfigLayer()),
  Layer.provideMerge(NodeHttpClient.layer),
  Layer.provideMerge(NodeContext.layer)
)

// Minimal layer for init/help (dummy services, won't be invoked)
const MinimalLayer = DummySyncEngineLayer.pipe(
  Layer.provideMerge(DummyConfluenceClientLayer),
  Layer.provideMerge(MarkdownConverterLayer),
  Layer.provideMerge(LocalFileSystemLayer),
  Layer.provideMerge(DummyConfigLayer),
  Layer.provideMerge(NodeTerminal.layer),
  Layer.provideMerge(NodeContext.layer)
)

// === Run CLI ===
const cli = Command.run(confluence, {
  name: pkg.name,
  version: pkg.version
})

// Check if we need the full layer based on command
const needsFullLayer = () => {
  const args = process.argv
  const cmd = args[2]
  // init, --help, -h, --version don't need config
  if (!cmd || cmd === "init" || cmd === "--help" || cmd === "-h" || cmd === "--version") {
    return false
  }
  return true
}

const main = Effect.suspend(() => cli(process.argv))

if (needsFullLayer()) {
  main.pipe(
    Effect.provide(AppLayer),
    Effect.tapErrorCause(Effect.logError),
    NodeRuntime.runMain
  )
} else {
  main.pipe(
    Effect.provide(MinimalLayer),
    Effect.tapErrorCause(Effect.logError),
    NodeRuntime.runMain
  )
}
