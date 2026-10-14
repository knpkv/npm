/** Current-pane self updates. The canonical hub applies the same host-scoped authorization as relay post. */
import type { ConnectSelfBody } from "@knpkv/herdr-connect"
import {
  connectReportResponseTimeoutMillis,
  ConnectSelfState,
  ConnectStoreBusyError,
  Denied,
  InvalidReport,
  TooManySelfUpdates,
  Unavailable,
  UnboundAgent
} from "@knpkv/herdr-connect"
import { decodeBoundedResponseJson, loadConfiguration } from "@knpkv/herdr-fleet"
import type { HostConfiguration } from "@knpkv/herdr-fleet/model"
import { Config, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { fleetConfigPath } from "./config-path.js"
import { RelayStoreBusyFailureBody } from "./relay-report-failure.js"
import { resolveReportingAgent } from "./relay-report-identity.js"

export const RelaySelfFailure = Schema.Union([
  InvalidReport,
  UnboundAgent,
  Denied,
  Unavailable,
  TooManySelfUpdates,
  ConnectStoreBusyError
])
const FailureBody = Schema.Union([
  RelayStoreBusyFailureBody,
  Schema.Struct({ error: Schema.Literal("InvalidReport"), detail: Schema.String }),
  Schema.Struct({ error: Schema.Literal("UnboundAgent"), agentId: Schema.String }),
  Schema.Struct({ error: Schema.Literal("Denied") }),
  Schema.Struct({ error: Schema.Literal("Unavailable"), operation: Schema.String }),
  Schema.Struct({ error: Schema.Literal("TooManySelfUpdates"), retryAfterMillis: Schema.Number })
])

/** No automatic retry: an uncertain accepted update must not silently consume another burst token. */
export const submitRelaySelf = Effect.fn("Relay.submitSelf")(
  function*(config: HostConfiguration, paneId: string, body: ConnectSelfBody) {
    const agentId = yield* resolveReportingAgent(config.herdrCommand, paneId)
    const client = yield* HttpClient.HttpClient
    const request = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post(new URL("/v1/connect/me", config.approvalHub.url).href).pipe(
        HttpClientRequest.setHeader("x-herdr-agent-id", agentId)
      ),
      body
    ).pipe(Effect.mapError(() => new InvalidReport({ detail: "could not encode self-state" })))
    return yield* Effect.gen(function*() {
      const response = yield* client.execute(request).pipe(
        Effect.mapError(() => new Unavailable({ operation: "self.request" }))
      )
      if (response.status < 200 || response.status >= 300) {
        const failure = yield* decodeBoundedResponseJson(response, FailureBody).pipe(
          Effect.mapError(() => new Unavailable({ operation: "self.response" }))
        )
        switch (failure.error) {
          case "ConnectStoreBusyError":
            return yield* new ConnectStoreBusyError({
              operation: failure.operation,
              timeoutMillis: failure.timeoutMillis,
              cause: response.status
            })
          case "InvalidReport":
            return yield* new InvalidReport({ detail: failure.detail })
          case "UnboundAgent":
            return yield* new UnboundAgent({ agentId: failure.agentId })
          case "Denied":
            return yield* new Denied()
          case "Unavailable":
            return yield* new Unavailable({ operation: failure.operation })
          case "TooManySelfUpdates":
            return yield* new TooManySelfUpdates({ retryAfterMillis: failure.retryAfterMillis })
        }
      }
      return yield* decodeBoundedResponseJson(response, ConnectSelfState).pipe(
        Effect.mapError(() => new Unavailable({ operation: "self.response" }))
      )
    }).pipe(Effect.timeoutOrElse({
      duration: connectReportResponseTimeoutMillis,
      orElse: () => Effect.fail(new Unavailable({ operation: "self.timeout" }))
    }))
  }
)

/** Shared transport for both CLI and MCP; configuration and identity are resolved for each invocation. */
export const reportRelaySelf = Effect.fn("Relay.reportSelf")(function*(body: ConnectSelfBody) {
  const paneId = yield* Config.String("HERDR_PANE_ID").pipe(
    Effect.mapError(() => new UnboundAgent({ agentId: "current-pane" }))
  )
  const path = yield* fleetConfigPath.pipe(Effect.mapError(() => new Unavailable({ operation: "self.configuration" })))
  const config = yield* loadConfiguration(path).pipe(
    Effect.mapError(() => new Unavailable({ operation: "self.configuration" }))
  )
  return yield* submitRelaySelf(config, paneId, body)
})
