/**
 * Node.js adapters for cli-auth: the OAuth callback server and token storage — the
 * only cli-auth file importing `@effect/platform-node`.
 *
 * @internal
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Layer from "effect/Layer"
import { createServer } from "node:http"
import { HomeDirectoryLive } from "../../config/ConfigPaths.js"
import { makeHttpServerFactory } from "./oauthServer.js"

export const HttpServerFactoryLive = makeHttpServerFactory(
  (options) => NodeHttpServer.layerServer(createServer, options)
)

/** Everything `makeAtlassianCliAuth` needs on Node besides HTTP client, spawner and Crypto. */
export const NodeCliAuthLive = Layer.mergeAll(
  HttpServerFactoryLive,
  NodeFileSystem.layer,
  NodePath.layer,
  HomeDirectoryLive
)
