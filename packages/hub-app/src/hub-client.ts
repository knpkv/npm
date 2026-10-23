/**
 * Shell services an app server calls: host facts, the hub's fleet reads, Fleet jobs and Relay posts.
 *
 * **Mental model**
 *
 * - Attached, each call is an HTTP request to the hub's loopback listener with the app's own token.
 *   Calls that act for a user carry the grant of the request being served ({@link CurrentGrant}); the hub
 *   resolves the caller from its own record, so an app can't claim a caller.
 * - Standalone, `host` answers locally and the rest fail `ShellServiceUnavailable("standalone")`; the app
 *   hides what they gate.
 * - A service the manifest doesn't declare fails `undeclared` before any request.
 *
 * @module
 */
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"
import { type AppId, GrantInvalid, type ShellService, ShellServiceUnavailable } from "./manifest.js"
import { CurrentGrant } from "./route.js"
import { appServicePaths, AppServiceRefusal, type FleetReadKind, HostInfo, hubHeaders, JobAccepted } from "./wire.js"

/** The hub took the request and refused it: a job its policy rejected, or a read it couldn't make. */
export class ShellServiceRefused extends Schema.TaggedError<ShellServiceRefused>()("ShellServiceRefused", {
  service: Schema.String,
  code: Schema.Literals(["rejected", "unavailable"])
}) {}

export interface ShellServiceCalls {
  readonly host: Effect.Effect<HostInfo, ShellServiceUnavailable>
  /** The hub's own JSON for the read; decode it with the read's schema. */
  readonly fleetRead: (
    read: FleetReadKind,
    query: Readonly<Record<string, string>>
  ) => Effect.Effect<Schema.Json, ShellServiceUnavailable | ShellServiceRefused>
  /** Submit a Fleet job for the caller of the request being served. */
  readonly submitJob: (
    payload: Schema.Json
  ) => Effect.Effect<JobAccepted, ShellServiceUnavailable | ShellServiceRefused | GrantInvalid>
  /** Post as the caller of the request being served, or as the app outside one. */
  readonly relayPost: (
    kind: "status" | "blocker",
    text: string
  ) => Effect.Effect<void, ShellServiceUnavailable | ShellServiceRefused | GrantInvalid>
}

export class ShellServices extends Context.Service<ShellServices, ShellServiceCalls>()(
  "@knpkv/hub-app/ShellServices"
) {}

/** Standalone: no hub. `host` is supplied by the runner from this machine. */
export const standaloneShellServices = (host: HostInfo): ShellServiceCalls => {
  const absent = (service: ShellService) => Effect.fail(new ShellServiceUnavailable({ service, reason: "standalone" }))
  return {
    host: Effect.succeed(host),
    fleetRead: () => absent("fleet.read"),
    submitJob: () => absent("jobs.submit"),
    relayPost: () => absent("relay.post")
  }
}

export interface AttachedOptions {
  readonly app: AppId
  readonly hubUrl: string
  /** This spawn's hub token, from the handshake. */
  readonly token: Redacted.Redacted<string>
  readonly declared: ReadonlyArray<ShellService>
}

/** Attached: every call goes to the hub's loopback listener with this app's current token. */
export const attachedShellServices = Effect.fn("HubApp.attachedShellServices")(function*(options: AttachedOptions) {
  const client = yield* HttpClient.HttpClient
  const url = (path: string) => new URL(path, options.hubUrl).href
  const authorized = (request: HttpClientRequest.HttpClientRequest) =>
    request.pipe(
      HttpClientRequest.bearerToken(Redacted.value(options.token)),
      HttpClientRequest.setHeader(hubHeaders.app, options.app)
    )
  const declare = (service: ShellService) =>
    options.declared.includes(service)
      ? Effect.void
      : Effect.fail(new ShellServiceUnavailable({ service, reason: "undeclared" }))
  const hubDown = (service: ShellService) => () => new ShellServiceUnavailable({ service, reason: "hub_down" })

  /** One request; a refusal body maps to its typed failure, anything else non-2xx is the hub being down. */
  const send = <A>(
    service: ShellService,
    request: Effect.Effect<HttpClientRequest.HttpClientRequest, unknown>,
    success: Schema.Codec<A, Schema.Json, never, never>
  ) =>
    Effect.gen(function*() {
      yield* declare(service)
      const response: HttpClientResponse.HttpClientResponse = yield* request.pipe(
        Effect.map(authorized),
        Effect.flatMap((built) => client.execute(built)),
        Effect.mapError(hubDown(service))
      )
      const body = yield* response.json.pipe(Effect.mapError(hubDown(service)))
      if (response.status >= 200 && response.status < 300) {
        return yield* Schema.decodeUnknownEffect(success)(body).pipe(Effect.mapError(hubDown(service)))
      }
      const refusal = yield* Schema.decodeUnknownEffect(AppServiceRefusal)(body).pipe(Effect.mapError(hubDown(service)))
      switch (refusal.code) {
        case "grant_unknown":
          return yield* new GrantInvalid({ reason: "unknown" })
        case "grant_expired":
          return yield* new GrantInvalid({ reason: "expired" })
        case "grant_used":
          return yield* new GrantInvalid({ reason: "used" })
        case "grant_app_mismatch":
          return yield* new GrantInvalid({ reason: "app_mismatch" })
        case "grant_read_only":
          return yield* new GrantInvalid({ reason: "read_only" })
        case "undeclared":
          return yield* new ShellServiceUnavailable({ service, reason: "undeclared" })
        case "rejected":
        case "unavailable":
          return yield* new ShellServiceRefused({ service, code: refusal.code })
        case "unauthorized":
          return yield* hubDown(service)()
      }
    })

  /** The grant of the request being served; outside one there is no caller to act for. */
  const requireGrant = Effect.gen(function*() {
    const grant = yield* CurrentGrant
    return grant === null ? yield* new GrantInvalid({ reason: "unknown" }) : grant
  })
  return ShellServices.of({
    host: send("host", Effect.succeed(HttpClientRequest.get(url(appServicePaths.host))), HostInfo).pipe(
      Effect.catchTags({
        ShellServiceRefused: () => Effect.fail(hubDown("host")()),
        GrantInvalid: () => Effect.fail(hubDown("host")())
      })
    ),
    fleetRead: (read, query) =>
      send(
        "fleet.read",
        HttpClientRequest.bodyJson(HttpClientRequest.post(url(appServicePaths.fleetRead)), { read, query }),
        Schema.Json
      ).pipe(Effect.catchTag("GrantInvalid", () => Effect.fail(hubDown("fleet.read")()))),
    submitJob: (payload) =>
      requireGrant.pipe(
        Effect.flatMap((grant) =>
          send(
            "jobs.submit",
            HttpClientRequest.bodyJson(HttpClientRequest.post(url(appServicePaths.jobs)), { grant, payload }),
            JobAccepted
          )
        )
      ),
    relayPost: (kind, text) =>
      Effect.gen(function*() {
        const grant = yield* CurrentGrant
        yield* send(
          "relay.post",
          HttpClientRequest.bodyJson(HttpClientRequest.post(url(appServicePaths.relay)), { grant, kind, text }),
          Schema.Struct({})
        )
      })
  })
})

export const attachedLayer = (options: AttachedOptions) => Layer.effect(ShellServices, attachedShellServices(options))

export const standaloneLayer = (host: HostInfo) => Layer.succeed(ShellServices, standaloneShellServices(host))
