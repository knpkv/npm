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
import { ConfluenceAuth, layer as ConfluenceAuthLayer } from "./ConfluenceAuth.js"
import { ConfluenceClient, type ConfluenceClientConfig, layer as ConfluenceClientLayer } from "./ConfluenceClient.js"
import {
  ConfluenceConfig,
  createConfigFile,
  layer as ConfluenceConfigLayer,
  layerFromValues as ConfluenceConfigLayerFromValues
} from "./ConfluenceConfig.js"
import { ConfigError } from "./ConfluenceError.js"
import { layer as LocalFileSystemLayer } from "./LocalFileSystem.js"
import { layer as MarkdownConverterLayer } from "./MarkdownConverter.js"
import { layer as SyncEngineLayer, SyncEngine } from "./SyncEngine.js"

// === Auth config ===
const AuthConfig = Config.all({
  apiKey: Config.string("CONFLUENCE_API_KEY"),
  email: Config.string("CONFLUENCE_EMAIL")
})

const getAuth = () =>
  Effect.gen(function*() {
    // 1. Try env vars first (backwards compat)
    const envAuth = yield* AuthConfig.pipe(
      Effect.map(({ apiKey, email }) => ({ type: "token" as const, email, token: apiKey })),
      Effect.option
    )

    if (Option.isSome(envAuth)) {
      return envAuth.value
    }

    // 2. Try OAuth token
    const auth = yield* ConfluenceAuth
    const accessToken = yield* auth.getAccessToken()
    const cloudId = yield* auth.getCloudId()

    return { type: "oauth2" as const, accessToken, cloudId }
  })

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

const messageOption = Options.text("message").pipe(
  Options.withAlias("m"),
  Options.withDescription("Revision comment message"),
  Options.optional
)

const pushCommand = Command.make(
  "push",
  { dryRun: dryRunOption, message: messageOption },
  ({ dryRun, message }) =>
    Effect.gen(function*() {
      const engine = yield* SyncEngine
      yield* Console.log(dryRun ? "Dry run - showing changes..." : "Pushing changes to Confluence...")
      const pushOptions = Option.isSome(message)
        ? { dryRun, message: message.value }
        : { dryRun }
      const result = yield* engine.push(pushOptions)
      yield* Console.log(`Pushed: ${result.pushed}, Created: ${result.created}, Skipped: ${result.skipped}`)
      if (result.errors.length > 0) {
        yield* Console.error("Errors:", result.errors.join("\n"))
      }
    })
).pipe(Command.withDescription("Upload local markdown changes to Confluence"))

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
    const auth = yield* ConfluenceAuth
    const user = yield* auth.getCurrentUser()

    // Show auth status first
    if (user) {
      yield* Console.log(`Logged in as: ${user.name} (${user.email})`)
    } else {
      yield* Console.log("Not logged in. Use 'confluence login' to authenticate.")
    }

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

// === Auth create command ===
const authCreateCommand = Command.make("create", {}, () =>
  Effect.gen(function*() {
    yield* Console.log(`
Creating OAuth app in Atlassian Developer Console...

1. Browser will open to create a new OAuth 2.0 (3LO) app
2. Enter app name (e.g., "Confluence CLI")
3. After creation, go to "Permissions" and add:
   - Confluence API (granular): read:page:confluence, write:page:confluence
   - User Identity API: read:me
4. Go to "Authorization" and set callback URL:
   http://localhost:8585/callback
5. Go to "Settings" and copy Client ID and Secret
6. Run: confluence auth configure --client-id <ID> --client-secret <SECRET>
`)
    const url = "https://developer.atlassian.com/console/myapps/create-3lo-app/"
    yield* Effect.promise(() =>
      import("node:child_process").then((cp) =>
        new Promise<void>((resolve, reject) => {
          const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
          cp.exec(`${cmd} "${url}"`, (err) => err ? reject(err) : resolve())
        })
      )
    )
  })).pipe(Command.withDescription("Create OAuth app in Atlassian Developer Console"))

// === Auth configure command ===
const clientIdOption = Options.text("client-id").pipe(
  Options.withDescription("OAuth client ID from Atlassian Developer Console"),
  Options.optional
)
const clientSecretOption = Options.text("client-secret").pipe(
  Options.withDescription("OAuth client secret"),
  Options.optional
)

const authConfigureCommand = Command.make(
  "configure",
  { clientId: clientIdOption, clientSecret: clientSecretOption },
  ({ clientId, clientSecret }) =>
    Effect.gen(function*() {
      const auth = yield* ConfluenceAuth

      const rawClientId = Option.isSome(clientId)
        ? clientId.value
        : yield* Prompt.text({ message: "Enter OAuth client ID:" })
      const rawClientSecret = Option.isSome(clientSecret)
        ? clientSecret.value
        : yield* Prompt.text({ message: "Enter OAuth client secret:" })

      yield* auth.configure({ clientId: rawClientId, clientSecret: rawClientSecret })
      yield* Console.log("OAuth configured. Run 'confluence auth login' to authenticate.")
    })
).pipe(Command.withDescription("Configure OAuth client credentials"))

// === Auth login command ===
const authLoginCommand = Command.make("login", {}, () =>
  Effect.gen(function*() {
    const auth = yield* ConfluenceAuth
    yield* auth.login()
  })).pipe(Command.withDescription("Authenticate with Atlassian via OAuth"))

// === Auth logout command ===
const authLogoutCommand = Command.make("logout", {}, () =>
  Effect.gen(function*() {
    const auth = yield* ConfluenceAuth
    yield* auth.logout()
    yield* Console.log("Logged out")
  })).pipe(Command.withDescription("Remove stored authentication"))

// === Auth command group ===
const authCommand = Command.make("auth").pipe(
  Command.withDescription("Manage OAuth authentication"),
  Command.withSubcommands([authCreateCommand, authConfigureCommand, authLoginCommand, authLogoutCommand])
)

// === Main command ===
const confluence = Command.make("confluence").pipe(
  Command.withDescription("Sync Confluence pages to local markdown"),
  Command.withSubcommands([
    initCommand,
    authCommand,
    pullCommand,
    pushCommand,
    syncCommand,
    statusCommand
  ])
)

// === Build app layer ===
// Dummy config layer for help/init
const DummyConfigLayer = ConfluenceConfigLayerFromValues({
  rootPageId: "dummy" as PageId,
  baseUrl: "https://dummy.atlassian.net",
  docsPath: ".docs/confluence",
  excludePatterns: [],
  saveSource: false
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
    push: (_options: { dryRun: boolean; message?: string }) =>
      Effect.dieMessage("Not configured - run 'confluence init' first"),
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

// Auth layer with HTTP client
const AuthLive = ConfluenceAuthLayer.pipe(Layer.provide(NodeHttpClient.layer))

// Full app layer with all services
const AppLayer = SyncEngineLayer.pipe(
  Layer.provideMerge(ConfluenceClientLive),
  Layer.provideMerge(MarkdownConverterLayer),
  Layer.provideMerge(LocalFileSystemLayer),
  Layer.provideMerge(ConfluenceConfigLayer()),
  Layer.provideMerge(AuthLive),
  Layer.provideMerge(NodeHttpClient.layer),
  Layer.provideMerge(NodeContext.layer)
)

// Auth-only layer for login/logout commands
const AuthOnlyLayer = DummySyncEngineLayer.pipe(
  Layer.provideMerge(DummyConfluenceClientLayer),
  Layer.provideMerge(AuthLive),
  Layer.provideMerge(MarkdownConverterLayer),
  Layer.provideMerge(LocalFileSystemLayer),
  Layer.provideMerge(DummyConfigLayer),
  Layer.provideMerge(NodeHttpClient.layer),
  Layer.provideMerge(NodeContext.layer)
)

// Dummy auth layer for init/help
const DummyConfluenceAuthLayer = Layer.succeed(
  ConfluenceAuth,
  ConfluenceAuth.of({
    configure: () => Effect.dieMessage("Not configured"),
    isConfigured: () => Effect.succeed(false),
    login: () => Effect.dieMessage("Not configured"),
    logout: () => Effect.dieMessage("Not configured"),
    getAccessToken: () => Effect.dieMessage("Not configured"),
    getCloudId: () => Effect.dieMessage("Not configured"),
    getCurrentUser: () => Effect.succeed(null),
    isLoggedIn: () => Effect.succeed(false)
  })
)

// Minimal layer for init/help (dummy services, won't be invoked)
const MinimalLayer = DummySyncEngineLayer.pipe(
  Layer.provideMerge(DummyConfluenceClientLayer),
  Layer.provideMerge(DummyConfluenceAuthLayer),
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

// Check what layer we need based on command
const getLayerType = (): "full" | "auth" | "minimal" => {
  const cmd = process.argv[2]
  // auth commands need auth layer only
  if (cmd === "auth") {
    return "auth"
  }
  // init, --help, -h, --version don't need config
  if (!cmd || cmd === "init" || cmd === "--help" || cmd === "-h" || cmd === "--version") {
    return "minimal"
  }
  return "full"
}

const main = Effect.suspend(() => cli(process.argv))

const layerType = getLayerType()

if (layerType === "full") {
  main.pipe(
    Effect.provide(AppLayer),
    Effect.tapErrorCause(Effect.logError),
    NodeRuntime.runMain
  )
} else if (layerType === "auth") {
  main.pipe(
    Effect.provide(AuthOnlyLayer),
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
