/**
 * Layer definitions for CLI commands.
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeTerminal from "@effect/platform-node/NodeTerminal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { Command } from "effect/unstable/cli"
import { layer as AdfSchemaValidatorLayer } from "../AdfSchemaValidator.js"
import { layer as AtlaskitTransformersLayer } from "../AtlaskitTransformers.js"
import { PageId } from "../Brand.js"
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
// Type-only: these feed the layer-coverage assertions below and must not create
// a runtime import cycle (clone.ts imports `ConverterPipeline` from here).
import type { pageCreateCommand, pagePatchCommand, pagePutCommand } from "./adfPage.js"
import type { attachmentCommand } from "./attachment.js"
import type { authCommand } from "./auth.js"
import type { cloneCommand } from "./clone.js"
import type { deleteCommand } from "./delete.js"
import type { pageGetCommand } from "./fetch.js"
import type { commitCommand, diffCommand, logCommand } from "./git.js"
import type { newCommand } from "./new.js"
import { getAuth } from "./shared.js"
import type { pullCommand, pushCommand, statusCommand } from "./sync.js"

/**
 * `MarkdownConverter` plus the validator it is built from.
 *
 * `AdfSchemaValidator` is merged rather than merely provided: `page put`,
 * `page patch` and `page create` resolve it directly (adfPage.ts) to check a
 * hand-authored document before writing it, so every layer that carries the
 * converter must re-export the validator too. Using `Layer.provide` here left
 * it consumed-but-unexported and the three commands died at startup with
 * `Service not found`.
 *
 * @internal
 */
export const ConverterPipeline = MarkdownConverterLayer.pipe(
  Layer.provide(AtlaskitTransformersLayer),
  Layer.provideMerge(AdfSchemaValidatorLayer)
)

// Dummy config layer for help/init
const DummyConfigLayer = ConfluenceConfigLayerFromValues({
  rootPageId: PageId("dummy"),
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
    getPageAttachments: () => Effect.die("Not configured"),
    uploadAttachmentToPage: () => Effect.die("Not configured"),
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
 * Compile-time proof that each layer exports every service the commands routed
 * to it resolve.
 *
 * Nothing else checks this. `Command.withSubcommands` collapses subcommand
 * requirements to `never` — `ExtractSubcommandContext` infers through
 * `T[number]`, a union, and that conditional is not distributive — so the root
 * command's `R` is `never` no matter what its leaves need, and `Effect.provide`
 * in `bin.ts` has nothing left to verify. `page put` shipped resolving
 * `AdfSchemaValidator` from a layer that did not export it, and `pnpm check`
 * stayed green. The leaf commands *do* still carry their real requirements, so
 * asserting against those, layer by layer, restores the check.
 *
 * A leaf added to `getLayerType` below belongs in the matching union here.
 */
type CommandRequirements<C> = C extends Command.Command<infer _N, infer _I, infer _CI, infer _E, infer R> ? R
  : never
type LayerServices<L> = L extends Layer.Layer<infer A, infer _E, infer _R> ? A : never
type Unprovided<C, L> = Exclude<CommandRequirements<C>, LayerServices<L> | Command.Environment>
type AssertNothingUnprovided<T extends never> = T

export type _FetchLayerCoversItsCommands = AssertNothingUnprovided<
  Unprovided<
    typeof pageGetCommand | typeof pagePutCommand | typeof pagePatchCommand | typeof pageCreateCommand,
    typeof FetchLayer
  >
>
export type _CloneLayerCoversItsCommands = AssertNothingUnprovided<
  Unprovided<typeof cloneCommand, typeof CloneLayer>
>
export type _AuthLayerCoversItsCommands = AssertNothingUnprovided<
  Unprovided<typeof authCommand, typeof AuthOnlyLayer>
>
// `page attachment upload --dry-run` is routed to the minimal layer, so that
// layer has to satisfy the attachment command too — not just the full one.
export type _MinimalLayerCoversItsCommands = AssertNothingUnprovided<
  Unprovided<typeof attachmentCommand, typeof MinimalLayer>
>
export type _AppLayerCoversItsCommands = AssertNothingUnprovided<
  Unprovided<
    | typeof statusCommand
    | typeof diffCommand
    | typeof pullCommand
    | typeof pushCommand
    | typeof commitCommand
    | typeof logCommand
    | typeof newCommand
    | typeof deleteCommand
    | typeof attachmentCommand,
    typeof AppLayer
  >
>

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
  // page get/create/put/patch talk to the API directly — auth + converter, no
  // workspace. `create` is the one that writes to a space rather than an
  // existing page, and it shares this layer and the base-URL allowlist path.
  if (
    cmd === "page" &&
    (subcommand === "get" || subcommand === "put" || subcommand === "patch" || subcommand === "create")
  ) {
    return "fetch"
  }
  if (
    cmd === "page" && subcommand === "attachment" && argv[2] === "upload" &&
    (argv.includes("--dry-run") || argv.includes("-n"))
  ) {
    return "minimal"
  }
  // skills/help/version don't need config
  if (!cmd || cmd === "skills" || cmd === "--help" || cmd === "-h" || cmd === "--version") {
    return "minimal"
  }
  return "full"
}
