/**
 * Layer composition for CLI commands with three tiers: full, auth-only, minimal.
 *
 * **Mental model**
 *
 * - **Lazy layer selection**: {@link getLayerType} inspects `process.argv[2]` to pick
 *   the smallest layer needed — `"minimal"` for help/version, `"auth"` for auth commands,
 *   `"full"` for search/get (which needs API client + issue service).
 * - **Dummy services**: Auth-only and minimal layers provide `Effect.dieMessage` stubs
 *   for unused services to satisfy the type system without initialization cost.
 *
 * @internal
 */
import * as NodeContext from "@effect/platform-node/NodeContext"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { JiraApiClient, JiraApiConfig } from "@knpkv/jira-api-client"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { IssueService, layer as IssueServiceLayer, SiteUrl } from "../IssueService.js"
import { JiraAuth, layer as JiraAuthLayer } from "../JiraAuth.js"
import { layer as MarkdownWriterLayer, MarkdownWriter } from "../MarkdownWriter.js"

// Dummy services for auth-only commands
const DummyIssueServiceLayer = Layer.succeed(
  IssueService,
  IssueService.of({
    getByKey: () => Effect.dieMessage("Not configured - run 'jira auth login' first"),
    search: () => Effect.dieMessage("Not configured - run 'jira auth login' first"),
    searchAll: () => Effect.dieMessage("Not configured - run 'jira auth login' first")
  })
)

const DummyMarkdownWriterLayer = Layer.succeed(
  MarkdownWriter,
  MarkdownWriter.of({
    writeMulti: () => Effect.dieMessage("Not configured"),
    writeSingle: () => Effect.dieMessage("Not configured")
  })
)

const DummyJiraAuthLayer = Layer.succeed(
  JiraAuth,
  JiraAuth.of({
    configure: () => Effect.dieMessage("Not configured"),
    isConfigured: () => Effect.succeed(false),
    login: () => Effect.dieMessage("Not configured"),
    logout: () => Effect.dieMessage("Not configured"),
    getAccessToken: () => Effect.dieMessage("Not configured"),
    getCloudId: () => Effect.dieMessage("Not configured"),
    getSiteUrl: () => Effect.dieMessage("Not configured"),
    getCurrentUser: () => Effect.succeed(null),
    isLoggedIn: () => Effect.succeed(false)
  })
)

// Auth layer with HTTP client
const AuthLive = JiraAuthLayer.pipe(Layer.provide(NodeHttpClient.layer))

// Build Jira API config layer dynamically based on auth
const JiraConfigLive = Layer.unwrapEffect(
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
const SiteUrlLive = Layer.unwrapEffect(
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
  Layer.provideMerge(IssueServiceLayer),
  Layer.provideMerge(SiteUrlLive),
  Layer.provideMerge(JiraClientLive),
  Layer.provideMerge(AuthLive),
  Layer.provideMerge(NodeHttpClient.layer),
  Layer.provideMerge(NodeContext.layer)
)

/**
 * Auth-only layer for auth commands.
 *
 * @category Layers
 */
export const AuthOnlyLayer = DummyIssueServiceLayer.pipe(
  Layer.provideMerge(DummyMarkdownWriterLayer),
  Layer.provideMerge(AuthLive),
  Layer.provideMerge(NodeHttpClient.layer),
  Layer.provideMerge(NodeContext.layer)
)

/**
 * Minimal layer for help/version commands.
 *
 * @category Layers
 */
export const MinimalLayer = DummyIssueServiceLayer.pipe(
  Layer.provideMerge(DummyMarkdownWriterLayer),
  Layer.provideMerge(DummyJiraAuthLayer),
  Layer.provideMerge(NodeContext.layer)
)

/**
 * Determine which layer to use based on command.
 *
 * @category Utilities
 */
export const getLayerType = (argv: ReadonlyArray<string>): "full" | "auth" | "minimal" => {
  const cmd = argv[2]
  if (cmd === "auth") {
    return "auth"
  }
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "--version") {
    return "minimal"
  }
  return "full"
}
