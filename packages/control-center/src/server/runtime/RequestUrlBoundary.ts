import * as Effect from "effect/Effect"
import type * as Types from "effect/Types"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { Buffer } from "node:buffer"

import { DEFAULT_HTTP_SECURITY_LIMITS } from "../http/security/HttpLimits.js"

/** Reject oversized UTF-8 request targets before route selection or body work. */
export const requestUrlBoundaryLayer = HttpRouter.middleware(
  Effect.succeed(
    (routeEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>) =>
      Effect.flatMap(
        HttpServerRequest.HttpServerRequest,
        (request) =>
          Buffer.byteLength(request.url, "utf8") > DEFAULT_HTTP_SECURITY_LIMITS.maximumRequestUrlBytes
            ? Effect.succeed(HttpServerResponse.text("URI Too Long", {
              status: 414,
              headers: { "cache-control": "no-store" }
            }))
            : routeEffect
      )
  ),
  { global: true }
)
