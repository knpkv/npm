/**
 * Binding the usage view to a loopback port, with the store and the background work behind it.
 *
 * **Mental model**
 *
 * - **One process, one operator, one origin.** The server listens on loopback, mints its own session
 *   at startup, and prints the URL that spends it.
 * - **The store opens before the port does.** A store that cannot be opened privately stops the
 *   server from starting rather than serving an empty page.
 *
 * @module
 */
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import * as OwnerSession from "@knpkv/browser-pairing/owner-session"
import { Config, Deferred, Effect, Layer, Schema } from "effect"
import { Etag, FetchHttpClient, HttpPlatform, HttpRouter } from "effect/http"
import * as Reactivity from "effect/reactivity/Reactivity"
import { createServer } from "node:http"
import { liveClaudeUsageDeps } from "../core/ClaudeLimitsLive.js"
import { databaseLayer } from "../core/Database.js"
import { type StoreError, UsageStore } from "../core/Store.js"
import { acliTicketSearch } from "../core/Tickets.js"
import type { LimitsNow } from "../shared/contracts.js"
import type { AgentUsageConfig } from "./Config.js"
import { controlSocket } from "./ControlSocket.js"
import { application } from "./HttpApplication.js"
import { readLimitsNow } from "./LimitsNow.js"
import { mintBootstrapUrl } from "./OwnerSession.js"
import { backgroundLayer, RuntimeState } from "./Runtime.js"

const HttpPlatformLive = HttpPlatform.layer.pipe(Layer.provide(NodeServices.layer))
const LoopbackHostname = Schema.Literals(["127.0.0.1", "localhost", "::1"])

export interface AgentUsageServerOptions {
  readonly config: AgentUsageConfig
  readonly hostname?: string
  readonly port: number
  readonly ready?: Deferred.Deferred<string>
  readonly security: OwnerSession.OwnerSessionService
}

/** The background ingest and polling, with their live dependencies. */
const background = (config: AgentUsageConfig) =>
  Layer.unwrap(Effect.gen(function*() {
    const claude = yield* liveClaudeUsageDeps(config.claudeCredentials)
    const ticketSearch = yield* acliTicketSearch
    return backgroundLayer({ roots: config.roots, claude, ticketSearch })
  }))

export const makeServer = (options: AgentUsageServerOptions) =>
  Layer.unwrap(
    Effect.gen(function*() {
      const hostname = yield* Schema.decodeUnknownEffect(LoopbackHostname)(options.hostname ?? "127.0.0.1")
      // Opened once the HTTP listener is up: the control socket mints nothing before then.
      const listening = yield* Deferred.make<void>()
      // The store opens after the socket (the socket holds its lock), so `limits` waits for it.
      const limitsReader = yield* Deferred.make<Effect.Effect<LimitsNow, StoreError>>()
      // The store's lock and login socket. Everything that touches the store or binds a port waits
      // for it, so a second server on this store stops before reading anything or binding.
      const control = Layer.effectDiscard(
        controlSocket(
          options.config.storeDirectory,
          options.security,
          Deferred.await(listening),
          Effect.flatten(Deferred.await(limitsReader))
        )
      ).pipe(
        Layer.provide(Reactivity.layer),
        Layer.provide(NodeServices.layer)
      )
      const store = databaseLayer(options.config.storeDirectory).pipe(Layer.provide(control))
      const services = Layer.mergeAll(
        store,
        RuntimeState.layer(options.config.roots.machine, options.config.projects)
      )
      // Bound only once the control layer holds the store's lock.
      const listener = NodeHttpServer.layerServer(createServer, { host: hostname, port: options.port }).pipe(
        Layer.provide(control)
      )
      const limits = Layer.effectDiscard(Effect.gen(function*() {
        const opened = yield* UsageStore
        const state = yield* RuntimeState
        yield* Deferred.succeed(limitsReader, readLimitsNow(opened, state.machine))
      }))
      return Layer.mergeAll(HttpRouter.serve(application), background(options.config), limits).pipe(
        Layer.provide(services),
        Layer.provide(listener),
        Layer.provide(Etag.layer),
        Layer.provide(HttpPlatformLive),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(NodeServices.layer),
        Layer.provide(Layer.succeed(OwnerSession.OwnerSession, options.security)),
        Layer.tap(() =>
          // The startup link: minted only once the server is listening, handed to whoever prints it.
          mintBootstrapUrl(options.security).pipe(
            Effect.tap(() => Deferred.succeed(listening, undefined)),
            Effect.flatMap((url) => options.ready === undefined ? Effect.void : Deferred.succeed(options.ready, url))
          )
        )
      )
    })
  )

/** The port to bind: next to jcf-web's 3111. */
export const Port = Config.Int("PORT").pipe(Config.withDefault(3112))

/** Set by `pnpm dev` so the printed URL points at the Vite dev server that proxies here. */
export const PublicOrigin = Config.option(Config.String("AGENT_USAGE_PUBLIC_ORIGIN"))
