/**
 * Layer composition for the jcf CLI and TUI runtime.
 *
 * @module
 */
import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import { ClockifyApiClient, ClockifyApiConfig } from "@knpkv/clockify-api-client"
import { JiraApiClient, JiraApiConfig } from "@knpkv/jira-api-client"
import { JiraAuth, layer as JiraAuthLayer } from "@knpkv/jira-cli/JiraAuth"
import { Effect, Layer, Redacted } from "effect"
import { ClockifyAuth, layer as ClockifyAuthLayer } from "../services/ClockifyAuth.js"
import { layer as ConfigLayer } from "../services/ConfigService.js"
import { layer as HomeDirectoryLayer } from "../services/HomeDirectory.js"
import { layer as StateWriterLayer } from "../services/StateWriter.js"
import { layer as TicketServiceLayer } from "../services/TicketService.js"
import { layer as TimerServiceLayer } from "../services/TimerService.js"

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

export const PlatformLayer = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici)

// ---------------------------------------------------------------------------
// Leaf layers
// ---------------------------------------------------------------------------

export const HomeDirectoryLive = HomeDirectoryLayer
export const ClockifyAuthLive = ClockifyAuthLayer.pipe(Layer.provide(HomeDirectoryLive), Layer.provide(PlatformLayer))
export const ConfigLive = ConfigLayer.pipe(Layer.provide(HomeDirectoryLive), Layer.provide(PlatformLayer))
export const StateWriterLive = StateWriterLayer.pipe(Layer.provide(HomeDirectoryLive), Layer.provide(PlatformLayer))
export const JiraAuthLive = JiraAuthLayer.pipe(Layer.provide(PlatformLayer))

// ---------------------------------------------------------------------------
// API config layers
// ---------------------------------------------------------------------------

export const ClockifyApiConfigLive = Layer.effect(
  ClockifyApiConfig,
  Effect.gen(function*() {
    const auth = yield* ClockifyAuth
    return yield* auth.getConfig.pipe(
      Effect.catch(() =>
        Effect.succeed({
          apiKey: Redacted.make(""),
          workspaceId: "",
          userId: "",
          baseUrl: "https://api.clockify.me/api"
        })
      )
    )
  })
).pipe(Layer.provide(ClockifyAuthLive))

export const ClockifyApiLive = ClockifyApiClient.layer.pipe(
  Layer.provide(ClockifyApiConfigLive)
)

export const JiraApiConfigLive = Layer.effect(
  JiraApiConfig,
  Effect.gen(function*() {
    const auth = yield* JiraAuth
    const accessToken = yield* auth.getAccessToken().pipe(
      Effect.catch(() => Effect.succeed(Redacted.make("")))
    )
    const cloudId = yield* auth.getCloudId().pipe(Effect.catch(() => Effect.succeed("")))
    return {
      baseUrl: "",
      auth: { type: "oauth2" as const, accessToken, cloudId }
    }
  })
).pipe(Layer.provide(JiraAuthLive))

export const JiraApiLive = JiraApiClient.layer.pipe(
  Layer.provide(JiraApiConfigLive),
  Layer.provide(PlatformLayer)
)

// ---------------------------------------------------------------------------
// Service layers
// ---------------------------------------------------------------------------

export const TicketServiceLive = TicketServiceLayer.pipe(
  Layer.provide(JiraApiLive),
  Layer.provide(ConfigLive)
)

export const TimerServiceLive = TimerServiceLayer.pipe(
  Layer.provide(ClockifyApiLive),
  Layer.provide(JiraApiLive),
  Layer.provide(JiraAuthLive),
  Layer.provide(ClockifyAuthLive),
  Layer.provide(ConfigLive),
  Layer.provide(StateWriterLive),
  Layer.provide(PlatformLayer)
)

// ---------------------------------------------------------------------------
// Fully closed layer for headless CLI
// ---------------------------------------------------------------------------

export const HeadlessLayer = Layer.mergeAll(
  TimerServiceLive,
  TicketServiceLive,
  ConfigLive,
  StateWriterLive,
  ClockifyAuthLive,
  ClockifyApiLive,
  JiraAuthLive,
  JiraApiLive
).pipe(Layer.provideMerge(PlatformLayer))
