/**
 * Layer definitions for CLI commands.
 */
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeTerminal from "@effect/platform-node/NodeTerminal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
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
import { TuiServiceAuthenticated, TuiServiceConfigured, TuiServiceUnauthenticated } from "./tui/TuiService.js"

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
    getPage: () => Effect.dieMessage("Not configured"),
    getChildren: () => Effect.dieMessage("Not configured"),
    getAllChildren: () => Effect.dieMessage("Not configured"),
    createPage: () => Effect.dieMessage("Not configured"),
    updatePage: () => Effect.dieMessage("Not configured"),
    deletePage: () => Effect.dieMessage("Not configured"),
    getPageVersions: () => Effect.dieMessage("Not configured"),
    getUser: () => Effect.dieMessage("Not configured"),
    getSpaceId: () => Effect.dieMessage("Not configured"),
    setEditorVersion: () => Effect.dieMessage("Not configured"),
    getSpaces: () => Effect.dieMessage("Not configured"),
    getRootPagesInSpace: () => Effect.dieMessage("Not configured")
  })
)

// Dummy sync engine that will fail if actually used
const DummySyncEngineLayer = Layer.succeed(
  SyncEngine,
  SyncEngine.of({
    pull: () => Effect.dieMessage("Not configured - run 'confluence clone' first"),
    push: (_options: { dryRun: boolean; message?: string }) =>
      Effect.dieMessage("Not configured - run 'confluence clone' first"),
    status: () => Effect.dieMessage("Not configured - run 'confluence clone' first")
  })
)

// Dummy git layer for auth/minimal
const notConfigured = () => Effect.dieMessage("Not configured - run 'confluence clone' first")
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

// Auth layer with HTTP client
const AuthLive = ConfluenceAuthLayer.pipe(Layer.provide(NodeHttpClient.layer))

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

/**
 * Full app layer with all services.
 */
export const AppLayer = SyncEngineLayer.pipe(
  Layer.provideMerge(UserCacheLayer),
  Layer.provideMerge(GitServiceLayer),
  Layer.provideMerge(ConfluenceClientLive),
  Layer.provideMerge(MarkdownConverterLayer),
  Layer.provideMerge(LocalFileSystemLayer),
  Layer.provideMerge(ConfluenceConfigLayer()),
  Layer.provideMerge(AuthLive),
  Layer.provideMerge(NodeHttpClient.layer),
  Layer.provideMerge(NodeContext.layer)
)

/**
 * Auth-only layer for login/logout commands.
 */
export const AuthOnlyLayer = DummySyncEngineLayer.pipe(
  Layer.provideMerge(UserCacheLayer),
  Layer.provideMerge(DummyGitServiceLayer),
  Layer.provideMerge(DummyConfluenceClientLayer),
  Layer.provideMerge(AuthLive),
  Layer.provideMerge(MarkdownConverterLayer),
  Layer.provideMerge(LocalFileSystemLayer),
  Layer.provideMerge(DummyConfigLayer),
  Layer.provideMerge(NodeHttpClient.layer),
  Layer.provideMerge(NodeContext.layer)
)

/**
 * Minimal layer for help - uses real GitService for clone.
 */
export const MinimalLayer = DummySyncEngineLayer.pipe(
  Layer.provideMerge(UserCacheLayer),
  Layer.provideMerge(GitServiceLayer),
  Layer.provideMerge(DummyConfluenceClientLayer),
  Layer.provideMerge(DummyConfluenceAuthLayer),
  Layer.provideMerge(MarkdownConverterLayer),
  Layer.provideMerge(LocalFileSystemLayer),
  Layer.provideMerge(DummyConfigLayer),
  Layer.provideMerge(NodeTerminal.layer),
  Layer.provideMerge(NodeContext.layer)
)

/**
 * Clone layer - needs auth + git but builds SyncEngine dynamically.
 */
export const CloneLayer = DummySyncEngineLayer.pipe(
  Layer.provideMerge(UserCacheLayer),
  Layer.provideMerge(GitServiceLayer),
  Layer.provideMerge(DummyConfluenceClientLayer),
  Layer.provideMerge(AuthLive),
  Layer.provideMerge(MarkdownConverterLayer),
  Layer.provideMerge(LocalFileSystemLayer),
  Layer.provideMerge(DummyConfigLayer),
  Layer.provideMerge(NodeHttpClient.layer),
  Layer.provideMerge(NodeTerminal.layer),
  Layer.provideMerge(NodeContext.layer)
)

// Build client layer dynamically from auth (no config needed)
const ConfluenceClientFromAuth = Layer.unwrapEffect(
  Effect.gen(function*() {
    const auth = yield* getAuth()

    // Get cloudId to construct baseUrl
    const authService = yield* ConfluenceAuth
    const cloudId = yield* authService.getCloudId()

    const clientConfig: ConfluenceClientConfig = {
      baseUrl: `https://api.atlassian.com/ex/confluence/${cloudId}`,
      auth
    }

    return ConfluenceClientLayer(clientConfig)
  })
)

/**
 * TUI layer - unauthenticated mode.
 */
export const TuiUnauthenticatedLayer = TuiServiceUnauthenticated.pipe(
  Layer.provideMerge(AuthLive),
  Layer.provideMerge(NodeHttpClient.layer),
  Layer.provideMerge(NodeContext.layer)
)

/**
 * TUI layer - authenticated mode (no config).
 */
export const TuiAuthenticatedLayer = TuiServiceAuthenticated.pipe(
  Layer.provideMerge(ConfluenceClientFromAuth),
  Layer.provideMerge(AuthLive),
  Layer.provideMerge(MarkdownConverterLayer),
  Layer.provideMerge(LocalFileSystemLayer),
  Layer.provideMerge(NodeHttpClient.layer),
  Layer.provideMerge(NodeContext.layer)
)

/**
 * TUI layer - configured mode (full functionality).
 */
export const TuiConfiguredLayer = TuiServiceConfigured.pipe(
  Layer.provideMerge(SyncEngineLayer),
  Layer.provideMerge(UserCacheLayer),
  Layer.provideMerge(GitServiceLayer),
  Layer.provideMerge(ConfluenceClientLive),
  Layer.provideMerge(AuthLive),
  Layer.provideMerge(MarkdownConverterLayer),
  Layer.provideMerge(LocalFileSystemLayer),
  Layer.provideMerge(ConfluenceConfigLayer()),
  Layer.provideMerge(NodeHttpClient.layer),
  Layer.provideMerge(NodeContext.layer)
)

/**
 * Determine which layer to use based on command.
 */
export const getLayerType = (): "full" | "auth" | "clone" | "minimal" | "tui" => {
  const cmd = process.argv[2]
  // auth commands need auth layer only
  if (cmd === "auth") {
    return "auth"
  }
  // clone needs auth + git but not config-dependent services
  if (cmd === "clone") {
    return "clone"
  }
  // tui uses mode detection internally
  if (cmd === "tui") {
    return "tui"
  }
  // --help, -h, --version don't need config
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "--version") {
    return "minimal"
  }
  return "full"
}
