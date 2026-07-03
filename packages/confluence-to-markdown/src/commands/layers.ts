/**
 * Layer definitions for CLI commands.
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeTerminal from "@effect/platform-node/NodeTerminal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { layer as AdfSchemaValidatorLayer } from "../AdfSchemaValidator.js"
import { layer as AtlaskitTransformersLayer } from "../AtlaskitTransformers.js"
import type { PageId } from "../Brand.js"
import { ConfluenceAuth, layer as ConfluenceAuthLayer } from "../ConfluenceAuth.js"
import { ConfluenceClient, type ConfluenceClientConfig, layer as ConfluenceClientLayer } from "../ConfluenceClient.js"
import {
  ConfluenceConfig,
  layer as ConfluenceConfigLayer,
  layerFromValues as ConfluenceConfigLayerFromValues
} from "../ConfluenceConfig.js"
import { GitService, layer as GitServiceLayer } from "../GitService.js"
import { UserCacheLayer } from "../internal/userCache.js"
import { layer as LocalFileSystemLayer } from "../LocalFileSystem.js"
import { layer as MarkdownConverterLayer } from "../MarkdownConverter.js"
import { layer as SyncEngineLayer, SyncEngine } from "../SyncEngine.js"
import { getAuth } from "./shared.js"

const ConverterPipeline = MarkdownConverterLayer.pipe(
  Layer.provide(AtlaskitTransformersLayer),
  Layer.provide(AdfSchemaValidatorLayer)
)

// Dummy config layer for help/init
const DummyConfigLayer = ConfluenceConfigLayerFromValues({
  rootPageId: "dummy" as PageId,
  baseUrl: "https://dummy.atlassian.net",
  docsPath: ".confluence/docs",
  excludePatterns: [],
  saveSource: false,
  trackedPaths: ["**/*.md"]
})

// Dummy client layer for help/init (will fail if actually used)
const DummyConfluenceClientLayer = Layer.succeed(
  ConfluenceClient,
  ConfluenceClient.of({
    getPage: () => Effect.die("Not configured"),
    getChildren: () => Effect.die("Not configured"),
    getAllChildren: () => Effect.die("Not configured"),
    createPage: () => Effect.die("Not configured"),
    updatePage: () => Effect.die("Not configured"),
    deletePage: () => Effect.die("Not configured"),
    getPageVersions: () => Effect.die("Not configured"),
    getUser: () => Effect.die("Not configured"),
    getSpaceId: () => Effect.die("Not configured"),
    setEditorVersion: () => Effect.die("Not configured")
  })
)

// Dummy sync engine that will fail if actually used
const DummySyncEngineLayer = Layer.succeed(
  SyncEngine,
  SyncEngine.of({
    pull: () => Effect.die("Not configured - run 'confluence workspace clone' first"),
    push: (_options: { dryRun: boolean; message?: string }) =>
      Effect.die("Not configured - run 'confluence workspace clone' first"),
    status: () => Effect.die("Not configured - run 'confluence workspace clone' first")
  })
)

// Dummy git layer for auth/minimal
const notConfigured = () => Effect.die("Not configured - run 'confluence workspace clone' first")
const DummyGitServiceLayer = Layer.succeed(
  GitService,
  GitService.of({
    validateGit: notConfigured,
    init: notConfigured,
    isInitialized: () => Effect.succeed(false),
    status: notConfigured,
    commit: notConfigured,
    log: notConfigured,
    diff: notConfigured,
    addAll: notConfigured,
    hasConflicts: () => Effect.succeed(false),
    mergeContinue: notConfigured,
    syncFromDocs: notConfigured,
    syncToDocs: notConfigured,
    getHead: notConfigured,
    getCurrentBranch: notConfigured,
    createBranch: notConfigured,
    checkout: notConfigured,
    reset: notConfigured,
    deleteBranch: notConfigured,
    getParent: notConfigured,
    cherryPick: (_ref: string, _options?: { strategy?: "ours" | "theirs" }) => notConfigured(),
    getChangedFiles: notConfigured,
    showFile: notConfigured,
    amend: notConfigured,
    logRange: notConfigured,
    branchExists: notConfigured,
    updateBranch: notConfigured,
    merge: notConfigured,
    getDeletedFiles: notConfigured,
    getFileContentAt: notConfigured
  })
)

// Dummy auth layer for init/help
const DummyConfluenceAuthLayer = Layer.succeed(
  ConfluenceAuth,
  ConfluenceAuth.of({
    configure: () => Effect.die("Not configured"),
    isConfigured: () => Effect.succeed(false),
    login: () => Effect.die("Not configured"),
    logout: () => Effect.die("Not configured"),
    getAccessToken: () => Effect.die("Not configured"),
    getCloudId: () => Effect.die("Not configured"),
    getCurrentUser: () => Effect.succeed(null),
    getActiveProfile: () => Effect.succeed(null),
    listProfiles: () => Effect.succeed([]),
    switchProfile: () => Effect.succeed(null),
    removeProfile: () => Effect.succeed(null),
    isLoggedIn: () => Effect.succeed(false)
  })
)

// Auth layer with HTTP client
const AuthLive = ConfluenceAuthLayer.pipe(Layer.provide(NodeHttpClient.layerFetch))

// Build client layer dynamically based on auth
const ConfluenceClientLive = Layer.unwrap(
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

/**
 * Full app layer with all services.
 */
export const AppLayer = SyncEngineLayer.pipe(
  Layer.provideMerge(UserCacheLayer),
  Layer.provideMerge(GitServiceLayer),
  Layer.provideMerge(ConfluenceClientLive),
  Layer.provideMerge(ConverterPipeline),
  Layer.provideMerge(LocalFileSystemLayer),
  Layer.provideMerge(ConfluenceConfigLayer()),
  Layer.provideMerge(AuthLive),
  Layer.provideMerge(NodeHttpClient.layerFetch),
  Layer.provideMerge(NodeServices.layer)
)

/**
 * Auth-only layer for login/logout commands.
 */
export const AuthOnlyLayer = DummySyncEngineLayer.pipe(
  Layer.provideMerge(UserCacheLayer),
  Layer.provideMerge(DummyGitServiceLayer),
  Layer.provideMerge(DummyConfluenceClientLayer),
  Layer.provideMerge(AuthLive),
  Layer.provideMerge(ConverterPipeline),
  Layer.provideMerge(LocalFileSystemLayer),
  Layer.provideMerge(DummyConfigLayer),
  Layer.provideMerge(NodeHttpClient.layerFetch),
  Layer.provideMerge(NodeServices.layer)
)

/**
 * Minimal layer for help - uses real GitService for clone.
 */
export const MinimalLayer = DummySyncEngineLayer.pipe(
  Layer.provideMerge(UserCacheLayer),
  Layer.provideMerge(GitServiceLayer),
  Layer.provideMerge(DummyConfluenceClientLayer),
  Layer.provideMerge(DummyConfluenceAuthLayer),
  Layer.provideMerge(ConverterPipeline),
  Layer.provideMerge(LocalFileSystemLayer),
  Layer.provideMerge(DummyConfigLayer),
  Layer.provideMerge(NodeTerminal.layer),
  Layer.provideMerge(NodeServices.layer)
)

/**
 * Clone layer - needs auth + git but builds SyncEngine dynamically.
 */
export const CloneLayer = DummySyncEngineLayer.pipe(
  Layer.provideMerge(UserCacheLayer),
  Layer.provideMerge(GitServiceLayer),
  Layer.provideMerge(DummyConfluenceClientLayer),
  Layer.provideMerge(AuthLive),
  Layer.provideMerge(ConverterPipeline),
  Layer.provideMerge(LocalFileSystemLayer),
  Layer.provideMerge(DummyConfigLayer),
  Layer.provideMerge(NodeHttpClient.layerFetch),
  Layer.provideMerge(NodeTerminal.layer),
  Layer.provideMerge(NodeServices.layer)
)

/**
 * Fetch layer - needs auth + converter but no config, sync engine, or git workspace.
 */
export const FetchLayer = DummySyncEngineLayer.pipe(
  Layer.provideMerge(UserCacheLayer),
  Layer.provideMerge(DummyGitServiceLayer),
  Layer.provideMerge(DummyConfluenceClientLayer),
  Layer.provideMerge(AuthLive),
  Layer.provideMerge(ConverterPipeline),
  Layer.provideMerge(LocalFileSystemLayer),
  Layer.provideMerge(DummyConfigLayer),
  Layer.provideMerge(NodeHttpClient.layerFetch),
  Layer.provideMerge(NodeTerminal.layer),
  Layer.provideMerge(NodeServices.layer)
)

/**
 * Determine which layer to use based on command.
 */
export const getLayerType = (argv: ReadonlyArray<string>): "full" | "auth" | "clone" | "fetch" | "minimal" => {
  const cmd = argv[0]
  const subcommand = argv[1]
  if (argv.includes("--help") || argv.includes("-h")) {
    return "minimal"
  }
  // auth commands need auth layer only
  if (cmd === "auth") {
    return "auth"
  }
  // clone needs auth + git but not config-dependent services
  if (cmd === "workspace" && subcommand === "clone") {
    return "clone"
  }
  // page get needs auth + converter but no existing config
  if (cmd === "page" && subcommand === "get") {
    return "fetch"
  }
  // skills/help/version don't need config
  if (!cmd || cmd === "skills" || cmd === "--help" || cmd === "-h" || cmd === "--version") {
    return "minimal"
  }
  return "full"
}
