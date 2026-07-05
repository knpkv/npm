/**
 * Layer composition for CLI commands with three tiers: full, auth-only, minimal.
 *
 * **Mental model**
 *
 * - **Lazy layer selection**: {@link getLayerType} inspects CLI arguments from `Stdio` to pick
 *   the smallest layer needed — `"minimal"` for help/version, `"auth"` for auth commands,
 *   `"full"` for issue/version reads and writes.
 * - **Dummy services**: Auth-only and minimal layers provide dying stubs
 *   for unused services to satisfy the type system without initialization cost.
 *
 * @internal
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { JiraApiClient, JiraApiConfig } from "@knpkv/jira-api-client"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { AttachmentService, layer as AttachmentServiceLayer } from "../AttachmentService.js"
import { IssueService, layer as IssueServiceLayer, SiteUrl } from "../IssueService.js"
import { JiraAuth, layer as JiraAuthLayer } from "../JiraAuth.js"
import { layer as MarkdownWriterLayer, MarkdownWriter } from "../MarkdownWriter.js"
import { layer as VersionServiceLayer, VersionService } from "../VersionService.js"

// Dummy services for auth-only commands
const DummyIssueServiceLayer = Layer.succeed(
  IssueService,
  IssueService.of({
    getByKey: () => Effect.die(new Error("Not configured - run 'jira auth login' first")),
    search: () => Effect.die(new Error("Not configured - run 'jira auth login' first")),
    searchAll: () => Effect.die(new Error("Not configured - run 'jira auth login' first"))
  })
)

const DummyAttachmentServiceLayer = Layer.succeed(
  AttachmentService,
  AttachmentService.of({
    uploadToIssue: () => Effect.die(new Error("Not configured - run 'jira auth login' first"))
  })
)

const DummyMarkdownWriterLayer = Layer.succeed(
  MarkdownWriter,
  MarkdownWriter.of({
    writeMulti: () => Effect.die(new Error("Not configured")),
    writeSingle: () => Effect.die(new Error("Not configured"))
  })
)

const DummyVersionServiceLayer = Layer.succeed(
  VersionService,
  VersionService.of({
    listProjectVersions: () => Effect.die(new Error("Not configured - run 'jira auth login' first")),
    getVersion: () => Effect.die(new Error("Not configured - run 'jira auth login' first")),
    updateVersion: () => Effect.die(new Error("Not configured - run 'jira auth login' first")),
    listRelatedWork: () => Effect.die(new Error("Not configured - run 'jira auth login' first")),
    addRelatedWork: () => Effect.die(new Error("Not configured - run 'jira auth login' first"))
  })
)

const DummyJiraAuthLayer = Layer.succeed(
  JiraAuth,
  JiraAuth.of({
    configure: () => Effect.die(new Error("Not configured")),
    isConfigured: () => Effect.succeed(false),
    login: () => Effect.die(new Error("Not configured")),
    logout: () => Effect.die(new Error("Not configured")),
    getAccessToken: () => Effect.die(new Error("Not configured")),
    getCloudId: () => Effect.die(new Error("Not configured")),
    getSiteUrl: () => Effect.die(new Error("Not configured")),
    getCurrentUser: () => Effect.succeed(null),
    getActiveProfile: () => Effect.succeed(null),
    listProfiles: () => Effect.succeed([]),
    switchProfile: () => Effect.succeed(null),
    removeProfile: () => Effect.succeed(null),
    isLoggedIn: () => Effect.succeed(false)
  })
)

// Auth layer with HTTP client
const AuthLive = JiraAuthLayer.pipe(Layer.provide(Layer.mergeAll(NodeHttpClient.layerUndici, NodeServices.layer)))

// Build Jira API config layer dynamically based on auth
const JiraConfigLive = Layer.unwrap(
  Effect.gen(function*() {
    const auth = yield* JiraAuth
    const accessToken = yield* auth.getAccessToken()
    const cloudId = yield* auth.getCloudId()

    return Layer.succeed(JiraApiConfig, {
      baseUrl: "",
      auth: {
        type: "oauth2" as const,
        accessToken,
        cloudId
      }
    })
  })
)

// Build Jira API client layer with config (no HttpClient needed — uses openapi-fetch)
const JiraClientLive = JiraApiClient.layer.pipe(
  Layer.provide(JiraConfigLive)
)

// Build SiteUrl layer from auth
const SiteUrlLive = Layer.unwrap(
  Effect.gen(function*() {
    const auth = yield* JiraAuth
    const siteUrl = yield* auth.getSiteUrl()
    return Layer.succeed(SiteUrl, siteUrl)
  })
)

/**
 * Full app layer with all services for search commands.
 *
 * @category Layers
 */
export const AppLayer = MarkdownWriterLayer.pipe(
  Layer.provideMerge(AttachmentServiceLayer),
  Layer.provideMerge(IssueServiceLayer),
  Layer.provideMerge(VersionServiceLayer),
  Layer.provideMerge(SiteUrlLive),
  Layer.provideMerge(JiraClientLive),
  Layer.provideMerge(AuthLive),
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.provideMerge(NodeServices.layer)
)

/**
 * Auth-only layer for auth commands.
 *
 * @category Layers
 */
export const AuthOnlyLayer = DummyIssueServiceLayer.pipe(
  Layer.provideMerge(DummyAttachmentServiceLayer),
  Layer.provideMerge(DummyMarkdownWriterLayer),
  Layer.provideMerge(DummyVersionServiceLayer),
  Layer.provideMerge(AuthLive),
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.provideMerge(NodeServices.layer)
)

/**
 * Minimal layer for help/version commands.
 *
 * @category Layers
 */
export const MinimalLayer = DummyIssueServiceLayer.pipe(
  Layer.provideMerge(DummyAttachmentServiceLayer),
  Layer.provideMerge(DummyMarkdownWriterLayer),
  Layer.provideMerge(DummyVersionServiceLayer),
  Layer.provideMerge(DummyJiraAuthLayer),
  Layer.provideMerge(NodeServices.layer)
)

/**
 * Determine which layer to use based on command.
 *
 * @category Utilities
 */
export const getLayerType = (args: ReadonlyArray<string>): "full" | "auth" | "minimal" => {
  const cmd = args[0]
  if (args.includes("--help") || args.includes("-h")) {
    return "minimal"
  }
  if (cmd === "auth") {
    return "auth"
  }
  if (
    cmd === "issue" && args[1] === "attachment" && args[2] === "upload" &&
    (args.includes("--dry-run") || args.includes("-n"))
  ) {
    return "minimal"
  }
  if (!cmd || cmd === "skills" || cmd === "--help" || cmd === "-h" || cmd === "--version") {
    return "minimal"
  }
  return "full"
}
