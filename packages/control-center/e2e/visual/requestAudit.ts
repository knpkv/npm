import * as HttpMiddleware from "effect/http/HttpMiddleware"
import * as Layer from "effect/Layer"
import * as Tracer from "effect/Tracer"

export interface VisualApiRequest {
  readonly method: string
  readonly path: string
}

/** Observe inbound requests before response completion, including setup calls and open SSE reads. */
export const makeVisualRequestAudit = () => {
  const requests: Array<VisualApiRequest> = []
  return {
    requests: (): ReadonlyArray<VisualApiRequest> => requests.slice(),
    layer: Layer.mergeAll(
      // A custom tracer enables Effect's HTTP span hook; raw attributes/headers are never emitted.
      Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
      Layer.succeed(HttpMiddleware.SpanNameGenerator, (request) => {
        if (request.url.startsWith("/api/")) {
          requests.push({ method: request.method, path: request.url.split("?")[0] ?? request.url })
        }
        return `http.server ${request.method}`
      })
    )
  }
}
