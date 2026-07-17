import { NodeHttpClient, NodeHttpServer } from "@effect/platform-node"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Etag from "effect/unstable/http/Etag"
import type * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import type * as HttpServer from "effect/unstable/http/HttpServer"
import type { ServeError } from "effect/unstable/http/HttpServerError"
import { Buffer } from "node:buffer"
import type * as Http from "node:http"
import { createServer as createHttpServer } from "node:http"
import type * as Https from "node:https"
import { createServer as createHttpsServer } from "node:https"

import { DEFAULT_HTTP_SECURITY_LIMITS } from "../http/security/HttpLimits.js"
import { SecretStore } from "../secrets/SecretStore.js"
import type { SecretStoreError } from "../secrets/SecretStoreError.js"
import type { BindConfig } from "../security/BindConfig.js"

type NodeServerServices =
  | Etag.Generator
  | HttpPlatform.HttpPlatform
  | HttpServer.HttpServer
  | NodeServices.NodeServices

/** Direct TLS configuration could not be turned into an HTTPS server. */
export class DirectTlsServerError extends Schema.TaggedErrorClass<DirectTlsServerError>()(
  "DirectTlsServerError",
  {
    reason: Schema.Literals(["material-missing", "material-invalid"])
  }
) {}

/** Runtime transport selected from a previously decoded bind policy. */
export type ControlCenterTransportProtocol = "http" | "https"

/** Node parser and connection budgets applied before Effect route handling. */
export interface NodeListenerSecurityPolicy {
  readonly maximumHeaderBytes: number
  readonly maximumHeaderCount: number
  readonly headersTimeoutMilliseconds: number
  readonly requestTimeoutMilliseconds: number
}

/** Conservative listener-level budgets shared by HTTP and direct TLS. */
export const NODE_LISTENER_SECURITY_POLICY: NodeListenerSecurityPolicy = {
  maximumHeaderBytes: DEFAULT_HTTP_SECURITY_LIMITS.maximumHeaderBytes,
  maximumHeaderCount: DEFAULT_HTTP_SECURITY_LIMITS.maximumHeaderCount,
  headersTimeoutMilliseconds: 15_000,
  requestTimeoutMilliseconds: 30_000
}

interface HardenableNodeServer {
  maxHeadersCount: number | null
  headersTimeout: number
  requestTimeout: number
}

const hardenNodeServer = <Server extends HardenableNodeServer>(server: Server): Server => {
  server.maxHeadersCount = NODE_LISTENER_SECURITY_POLICY.maximumHeaderCount
  server.headersTimeout = NODE_LISTENER_SECURITY_POLICY.headersTimeoutMilliseconds
  server.requestTimeout = NODE_LISTENER_SECURITY_POLICY.requestTimeoutMilliseconds
  return server
}

const httpServerOptions: Http.ServerOptions = {
  maxHeaderSize: NODE_LISTENER_SECURITY_POLICY.maximumHeaderBytes,
  headersTimeout: NODE_LISTENER_SECURITY_POLICY.headersTimeoutMilliseconds,
  requestTimeout: NODE_LISTENER_SECURITY_POLICY.requestTimeoutMilliseconds
}

/** Return the listener protocol implied by the validated transport policy. */
export const controlCenterTransportProtocol = (
  bindConfig: BindConfig
): ControlCenterTransportProtocol => bindConfig.transportPolicy === "direct-tls" ? "https" : "http"

/** Construct HTTPS while releasing source secret leases as soon as Node has parsed them. */
export const makeDirectTlsNodeServer = Effect.fn("ControlCenterNodeTransport.httpsServer")(function*(
  bindConfig: BindConfig
) {
  const directTls = bindConfig.directTls
  if (directTls === null) {
    return yield* new DirectTlsServerError({ reason: "material-missing" })
  }
  return yield* Effect.scoped(Effect.gen(function*() {
    const secrets = yield* SecretStore
    const certificate = yield* secrets.resolve(directTls.certificateRef)
    const privateKey = yield* secrets.resolve(directTls.privateKeyRef)
    return yield* certificate.withBytes((certificateBytes) =>
      privateKey.withBytes((privateKeyBytes) =>
        Effect.acquireUseRelease(
          Effect.sync(() => ({
            certificate: Buffer.from(certificateBytes),
            privateKey: Buffer.from(privateKeyBytes)
          })),
          ({ certificate, privateKey }) =>
            Effect.try({
              try: () => {
                const serverOptions: Https.ServerOptions = {
                  cert: certificate,
                  key: privateKey,
                  maxHeaderSize: NODE_LISTENER_SECURITY_POLICY.maximumHeaderBytes,
                  headersTimeout: NODE_LISTENER_SECURITY_POLICY.headersTimeoutMilliseconds,
                  requestTimeout: NODE_LISTENER_SECURITY_POLICY.requestTimeoutMilliseconds
                }
                return hardenNodeServer(createHttpsServer(serverOptions))
              },
              catch: () => new DirectTlsServerError({ reason: "material-invalid" })
            }),
          ({ certificate, privateKey }) =>
            Effect.sync(() => {
              certificate.fill(0)
              privateKey.fill(0)
            })
        )
      )
    )
  }))
})

/** Build the Node listener required by the validated transport mode. */
export const makeNodeTransportLayer = (
  bindConfig: BindConfig
): Layer.Layer<
  NodeServerServices,
  DirectTlsServerError | SecretStoreError | ServeError,
  SecretStore
> => {
  const listen = { host: bindConfig.host, port: bindConfig.port }
  if (controlCenterTransportProtocol(bindConfig) === "http") {
    return NodeHttpServer.layer(
      () => hardenNodeServer(createHttpServer(httpServerOptions)),
      listen
    )
  }
  return Layer.unwrap(
    makeDirectTlsNodeServer(bindConfig).pipe(
      Effect.map((server) => NodeHttpServer.layer(() => server, listen))
    )
  )
}

/** Node platform services used to acquire the owner-only secret store before listening. */
export const nodeSecretPlatformLayer = NodeServices.layer

/** Node outbound HTTP client used by first-party provider adapters. */
export const nodeOutboundHttpClientLayer = NodeHttpClient.layerFetch
