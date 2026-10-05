/**
 * Binding the week view to a loopback port.
 *
 * **Mental model**
 *
 * - **One process, one operator, one origin.** The server listens on loopback, mints its own session
 *   at startup, and prints the URL that spends it. There is nothing to configure and nobody to
 *   authenticate against.
 * - **The engine is the same one the CLI runs.** `HeadlessLayer` from `@knpkv/jira-clockify` is
 *   provided whole, so a week read here and a `jcf sync reconcile --agent` in a terminal derive from
 *   the same services against the same config.
 *
 * @module
 */
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import * as OwnerSession from "@knpkv/browser-pairing/owner-session"
import { Layers } from "@knpkv/jira-clockify"
import { Config, Deferred, Effect, Layer, Schema } from "effect"
import { Etag, HttpPlatform, HttpRouter } from "effect/http"
import { createServer } from "node:http"
import { application } from "./HttpApplication.js"

const HttpPlatformLive = HttpPlatform.layer.pipe(Layer.provide(NodeServices.layer))

export interface JcfWebServerOptions {
  readonly hostname?: string
  readonly port: number
  /** Completed with the bootstrap URL once the server is listening. */
  readonly ready?: Deferred.Deferred<string>
  readonly security: OwnerSession.OwnerSessionService
}

export const makeServer = (options: JcfWebServerOptions) =>
  Layer.unwrap(
    Schema.decodeUnknownEffect(OwnerSession.LoopbackHostname)(options.hostname ?? "127.0.0.1").pipe(
      Effect.map((hostname) =>
        HttpRouter.serve(application.pipe(Layer.provide(Layers.HeadlessLayer))).pipe(
          Layer.provide(
            NodeHttpServer.layerServer(createServer, { host: hostname, port: options.port })
          ),
          Layer.provide(Etag.layer),
          Layer.provide(HttpPlatformLive),
          Layer.provide(NodeServices.layer),
          Layer.provide(Layer.succeed(OwnerSession.OwnerSession, options.security)),
          Layer.tap(() =>
            // The startup link: minted only once the server is listening, handed to whoever prints it.
            options.security.mintBootstrapCode.pipe(
              Effect.map((code) => OwnerSession.bootstrapUrl(options.security.browserOrigin, code)),
              Effect.flatMap((url) => options.ready === undefined ? Effect.void : Deferred.succeed(options.ready, url))
            )
          )
        )
      )
    )
  )

/** The port to bind. Deliberately not 3000: the CodeCommit web app already lives there. */
export const Port = Config.Int("PORT").pipe(Config.withDefault(3111))

/** Set by `pnpm dev` so the printed URL points at the Vite dev server that proxies here. */
export const PublicOrigin = Config.option(Config.String("JCF_WEB_PUBLIC_ORIGIN"))
