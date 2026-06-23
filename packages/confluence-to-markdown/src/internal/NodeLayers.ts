/**
 * Node.js-specific layer implementations.
 *
 * This file wires package-specific Node runtime layers.
 *
 * @module
 * @internal
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { createServer } from "node:http"
import { makeHttpServerFactory } from "./oauthServer.js"

/**
 * HTTP Server factory layer using Node.js http module.
 *
 * @category Layers
 */
export const HttpServerFactoryLive = makeHttpServerFactory(
  (port) => NodeHttpServer.layerServer(createServer, { port })
)
