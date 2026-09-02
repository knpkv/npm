/**
 * Layer composition for the jcf CLI and TUI runtime.
 *
 * @module
 */
import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import { ClockifyApiClient, ClockifyApiConfig } from "@knpkv/clockify-api-client"
import { JiraApiClient, JiraApiConfig, type JiraApiCredential } from "@knpkv/jira-api-client"
import { JiraAuth, layer as JiraAuthLayer } from "@knpkv/jira-cli/JiraAuth"
import { Effect, Layer, Redacted } from "effect"
import * as Logger from "effect/Logger"
import { layer as AgentSessionReaderLayer } from "../services/AgentSessionReader.js"
import { ClockifyAuth, layer as ClockifyAuthLayer } from "../services/ClockifyAuth.js"
import { layer as ConfigLayer } from "../services/ConfigService.js"
import { layer as HomeDirectoryLayer } from "../services/HomeDirectory.js"
import { layer as ReconcileServiceLayer } from "../services/ReconcileService.js"
import { layer as SessionAttributorLayer } from "../services/SessionAttributor.js"
import { layer as StateWriterLayer } from "../services/StateWriter.js"
import { layer as TicketServiceLayer } from "../services/TicketService.js"
import { layer as TimerServiceLayer } from "../services/TimerService.js"

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

/**
 * Diagnostics belong on stderr. The default logger writes to stdout, which corrupts every `--json`
 * output: one warning turns "exactly one JSON value on stdout" into unparseable output for whatever
 * is reading it. Warnings stay visible, just on the stream reserved for them.
 *
 * Part of the layer rather than the binary so the test seam inherits the same routing the real CLI
 * runs with, instead of the two drifting apart.
 */
export const LogToStderrLive = Layer.succeed(Logger.LogToStderr, true)

// HttpClient backs TimerService's raw Jira worklog POST. Use the fetch implementation, not
// undici: the TUI runs under Bun (see main.tsx) where undici fails with a transport error,
// while fetch works in both Bun and Node — the same fetch the Jira/Clockify API clients use.
export const PlatformLayer = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerFetch)

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
  Layer.provide(ClockifyApiConfigLive),
  Layer.provide(PlatformLayer)
)

// This layer is built before any command body runs — `HeadlessLayer` is
// provided to the whole program — so a stall in `getAccessToken`, which
// refreshes an expired OAuth token over the network, hangs the process the way
// bounding the Clockify calls in `timer/status.ts` was meant to prevent.
//
// The bound for that lives in `JiraAuth.refreshTokenImpl` (30s), not here: a
// timeout on this call would be inert, because the rotation is uninterruptible,
// `Effect.timeout` is a race, and racing an uninterruptible loser means waiting
// for it anyway.
//
// The credential is resolved per request, not once here. An access token lasts
// about an hour, so a value captured at layer construction is a deadline on the
// process: `jcf watch` runs all day, and the TUI's runtime
// (`tui/atoms/runtime.ts`) is memoized for a whole session. Both used to 401
// every Jira call from the first expiry onward, with the empty-credential
// fallback below turning any transient failure at startup into the same thing
// permanently. `resolveAuth` is re-read before each request, so a refresh — by
// this process or another — reaches the next call.
//
// `getAccessToken` is cheap to call repeatedly: it reads the stored token and
// returns it unless it has actually expired, and holds a lock so concurrent
// callers share one refresh.
//
// `getCloudId` needs no bound; it only reads the stored token file.
export const JiraApiConfigLive = Layer.effect(
  JiraApiConfig,
  Effect.gen(function*() {
    const auth = yield* JiraAuth
    // Infallible by construction, because request preprocessing has nowhere to put an error. An
    // empty token yields the same 401 as never having logged in, which is what the caller reports.
    const resolveAuth: Effect.Effect<JiraApiCredential> = Effect.gen(function*() {
      const accessToken = yield* auth.getAccessToken().pipe(
        Effect.catch(() => Effect.succeed(Redacted.make("")))
      )
      const cloudId = yield* auth.getCloudId().pipe(Effect.catch(() => Effect.succeed("")))
      return { type: "oauth2", accessToken, cloudId }
    })
    return {
      baseUrl: "",
      // Read once for the snapshot every non-refreshing consumer still reads, and again per request.
      auth: yield* resolveAuth,
      resolveAuth
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

export const AgentSessionReaderLive = AgentSessionReaderLayer.pipe(
  Layer.provide(HomeDirectoryLive),
  Layer.provide(ConfigLive),
  Layer.provide(PlatformLayer)
)

// Constructing this spawns nothing — the Claude CLI is only invoked when a session no
// deterministic Attribution Signal could place actually needs attributing.
export const SessionAttributorLive = SessionAttributorLayer.pipe(
  Layer.provide(HomeDirectoryLive),
  Layer.provide(PlatformLayer)
)

export const ReconcileServiceLive = ReconcileServiceLayer.pipe(
  Layer.provide(HomeDirectoryLive),
  Layer.provide(ClockifyApiLive),
  Layer.provide(ClockifyAuthLive),
  Layer.provide(JiraApiLive),
  Layer.provide(JiraAuthLive),
  Layer.provide(ConfigLive),
  Layer.provide(TimerServiceLive),
  Layer.provide(AgentSessionReaderLive),
  Layer.provide(SessionAttributorLive)
)

// ---------------------------------------------------------------------------
// Fully closed layer for headless CLI
// ---------------------------------------------------------------------------

/**
 * The services the application services are built *from*.
 *
 * Separated because `Layer.mergeAll` builds its members in parallel: a dependency listed alongside
 * its dependent is not guaranteed to exist when the dependent is constructed. These go underneath
 * via `provideMerge`, which both orders them first and keeps them in the result, so a command can
 * still reach `ConfigService` directly.
 */
const FoundationLayer = Layer.mergeAll(
  ConfigLive,
  StateWriterLive,
  ClockifyAuthLive,
  ClockifyApiLive,
  JiraAuthLive,
  JiraApiLive,
  AgentSessionReaderLive,
  SessionAttributorLive,
  LogToStderrLive
).pipe(Layer.provideMerge(PlatformLayer))

export const HeadlessLayer = Layer.mergeAll(
  TimerServiceLive,
  ReconcileServiceLive,
  TicketServiceLive
).pipe(Layer.provideMerge(FoundationLayer))
