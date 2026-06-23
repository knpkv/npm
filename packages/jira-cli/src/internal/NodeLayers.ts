/**
 * Node.js-specific HTTP server factory — the only file importing `@effect/platform-node` server.
 *
 * @internal
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { makeHttpServerFactory } from "./oauthServer.js"

/**
 * HTTP Server factory layer using Node.js http module.
 *
 * @category Layers
 */
export const HttpServerFactoryLive = makeHttpServerFactory(
  () => NodeHttpServer.layerTest
)
