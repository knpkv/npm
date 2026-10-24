/**
 * The hub's HTTP surface for apps:
 *
 * - `GET /v1/apps`: every registered app's state, for the shell's navigation.
 * - `/apps/<id>/v1/modules/<id>/*` and `/apps/<id>/app/assets/*`: authenticated on the hub's listener,
 *   then proxied to the app's endpoint with its spawn's secret, the caller, a request id and a grant.
 * - `/v1/app-services/*` (loopback listener only): what an app server asks of the hub, authenticated by
 *   the app's token.
 *
 * Unknown apps and paths answer 404, unreachable apps 503 `app_unavailable`. Nothing here answers 500
 * for an app's fault.
 *
 * @module
 */
import {
  type AppId,
  AppId as AppIdSchema,
  appPaths,
  appServicePaths,
  AppStates,
  FleetReadRequest,
  GrantInvalid,
  HostInfo,
  hubHeaders,
  JobAccepted,
  JobSubmission,
  ModuleCaller,
  RelayPost,
  type ShellService
} from "@knpkv/hub-app"
import { Effect, type Exit, Option, Redacted, Schema } from "effect"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { ListenerMode } from "../internal/listener.js"
import type { AppTokens, Grants } from "./grants.js"
import type { AppRegistry } from "./registry.js"
import { proxyToSocket } from "./socket.js"

/** App requests may take this long by default; long enough for a slow read, short enough to free the socket. */
const defaultProxyTimeoutMillis = 30_000

const send = (response: ServerResponse, status: number, body: Schema.Json): void => {
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" })
  response.end(`${JSON.stringify(body)}\n`)
}

const encodeCaller = Schema.encodeSync(Schema.fromJsonString(ModuleCaller))
const encodeStates = Schema.encodeSync(AppStates)

export interface AppsRouteContext<E, R> {
  readonly listener: ListenerMode
  readonly registry: AppRegistry
  readonly grants: Grants
  /** The caller this listener authenticated; fails when the request may not use the hub. */
  readonly authorize: Effect.Effect<typeof ModuleCaller.Encoded, E, R>
  /** Fails when a mutation did not come from the hub's own page. */
  readonly sameOrigin: Effect.Effect<unknown, E, R>
  readonly refuse: (response: ServerResponse, error: E) => void
  readonly runtime: { readonly runPromiseExit: <A, X>(effect: Effect.Effect<A, X, R>) => Promise<Exit.Exit<A, X>> }
  /** Defaults to 30 s. */
  readonly proxyTimeoutMillis?: number
}

/** Run `effect`; answer its typed failure through `refuse`, a defect as 500. Null after answering. */
const runChecked = async <A, E, R>(
  context: AppsRouteContext<E, R>,
  response: ServerResponse,
  effect: Effect.Effect<A, E, R>
): Promise<Option.Option<A>> => {
  const exit = await context.runtime.runPromiseExit(effect)
  if (exit._tag === "Success") return Option.some(exit.value)
  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (failure !== undefined && failure._tag === "Fail") context.refuse(response, failure.error)
  else send(response, 500, { error: "internal" })
  return Option.none()
}

/** The app id and the path inside it, for `/apps/<id>/<rest>`. */
const appTarget = (pathname: string): { readonly id: AppId; readonly rest: string } | null => {
  const match = /^\/apps\/([^/]+)(\/.*)$/u.exec(pathname)
  if (match === null) return null
  const id = Schema.decodeUnknownOption(AppIdSchema)(match[1])
  return Option.isNone(id) || match[2] === undefined ? null : { id: id.value, rest: match[2] }
}

/** Answers `request` when it is `/v1/apps` or `/apps/*`, and says whether it was. */
export const handleAppsRoute = async <E, R>(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: AppsRouteContext<E, R>
): Promise<boolean> => {
  const method = request.method ?? "GET"
  if (url.pathname === "/v1/apps") {
    if (method !== "GET") {
      send(response, 405, { error: "method_not_allowed" })
      return true
    }
    const caller = await runChecked(context, response, context.authorize)
    if (Option.isNone(caller)) return true
    const apps = await context.runtime.runPromiseExit(context.registry.apps)
    if (apps._tag === "Failure") {
      send(response, 500, { error: "internal" })
      return true
    }
    send(response, 200, encodeStates({ contract: 1, apps: apps.value.map((app) => app.state) }))
    return true
  }
  if (!url.pathname.startsWith("/apps/")) return false

  const target = appTarget(url.pathname)
  const apps = await context.runtime.runPromiseExit(context.registry.apps)
  const app = target === null || apps._tag === "Failure"
    ? undefined
    : apps.value.find((candidate) => candidate.id === target.id)
  if (target === null || app === undefined) {
    send(response, 404, { error: "not_found" })
    return true
  }
  const moduleRoute = target.rest.startsWith(`/v1/modules/${target.id}/`)
  const asset = method === "GET" && target.rest.startsWith(appPaths.assets)
  if (!moduleRoute && !asset) {
    send(response, 404, { error: "not_found" })
    return true
  }
  if (app.state._tag !== "Ready" || app.reach === null) {
    send(response, 503, {
      error: "app_unavailable",
      reason: app.state._tag === "Unavailable" ? app.state.reason : "not_running"
    })
    return true
  }
  if (moduleRoute && !app.state.manifest.module.listeners.some((listener) => listener === context.listener)) {
    send(response, 404, { error: "not_found" })
    return true
  }
  const mutation = moduleRoute && method !== "GET" && method !== "HEAD"
  const checked = await runChecked(
    context,
    response,
    mutation ? Effect.tap(context.authorize, () => context.sameOrigin) : context.authorize
  )
  if (Option.isNone(checked)) return true
  const caller = Schema.decodeUnknownOption(ModuleCaller)(checked.value)
  if (Option.isNone(caller)) {
    send(response, 500, { error: "invalid_caller" })
    return true
  }
  // Assets carry no caller: only module routes act for someone.
  const minted = moduleRoute
    ? await context.runtime.runPromiseExit(context.grants.mint(app.id, caller.value, method))
    : null
  if (minted !== null && minted._tag === "Failure") {
    send(response, 500, { error: "internal" })
    return true
  }
  // The spawn's secret goes with every request, assets included: the app answers nothing without it.
  const secret = { [hubHeaders.appSecret]: Redacted.value(app.reach.secret) }
  const added = minted === null
    ? secret
    : {
      ...secret,
      [hubHeaders.requestId]: minted.value.requestId,
      [hubHeaders.listener]: context.listener,
      [hubHeaders.caller]: encodeCaller(caller.value),
      [hubHeaders.grant]: minted.value.grant
    }
  const path = `${target.rest}${url.search}`
  const proxied = await context.runtime.runPromiseExit(
    proxyToSocket(
      app.reach.endpoint,
      `/apps/${app.id}/`,
      path,
      request,
      response,
      added,
      context.proxyTimeoutMillis ?? defaultProxyTimeoutMillis
    )
  )
  if (proxied._tag === "Failure" && !response.headersSent) {
    const timedOut = proxied.cause.reasons.some((entry) => entry._tag === "Fail" && entry.error.reason === "timeout")
    // One slow route doesn't make the app unavailable: a fresh probe decides, in the background.
    void context.runtime.runPromiseExit(context.registry.probeOne(app.id))
    if (timedOut) send(response, 504, { error: "app_timeout" })
    else send(response, 503, { error: "app_unavailable", reason: "not_running" })
  }
  return true
}

/** The hub refused an app's job or read; `code` matches the wire's refusal codes. */
export class AppServiceRefused extends Schema.TaggedError<AppServiceRefused>()("AppServiceRefused", {
  code: Schema.Literals(["rejected", "unavailable"])
}) {}

export interface AppServicesContext<R> {
  /** Served on the loopback listener only; every other listener leaves the path to the hub's 404. */
  readonly listener: ListenerMode
  readonly registry: AppRegistry
  readonly grants: Grants
  readonly tokens: AppTokens
  readonly host: HostInfo
  readonly fleetRead: (request: FleetReadRequest) => Effect.Effect<Schema.Json, AppServiceRefused, R>
  readonly submitJob: (payload: Schema.Json, caller: ModuleCaller) => Effect.Effect<JobAccepted, AppServiceRefused, R>
  readonly relayPost: (
    post: { readonly kind: RelayPost["kind"]; readonly text: string },
    author: { readonly app: AppId; readonly caller: ModuleCaller | null }
  ) => Effect.Effect<void, AppServiceRefused, R>
  readonly readJson: <A>(schema: Schema.Codec<A, unknown, never, never>) => Effect.Effect<A, unknown, R>
  readonly runtime: { readonly runPromiseExit: <A, X>(effect: Effect.Effect<A, X, R>) => Promise<Exit.Exit<A, X>> }
}

const grantRefusal = (error: GrantInvalid) => {
  switch (error.reason) {
    case "unknown":
      return "grant_unknown"
    case "expired":
      return "grant_expired"
    case "used":
      return "grant_used"
    case "app_mismatch":
      return "grant_app_mismatch"
    case "read_only":
      return "grant_read_only"
  }
}

/**
 * Answers `/v1/app-services/*` on the loopback listener, and says whether it was one. The app names
 * itself in `x-hub-app` and proves it with its bearer token; each service must be in its manifest.
 */
export const handleAppServicesRoute = async <R>(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: AppServicesContext<R>
): Promise<boolean> => {
  if (context.listener !== "local" || !url.pathname.startsWith("/v1/app-services/")) return false
  const method = request.method ?? "GET"
  const service: ShellService | null = method === "GET" && url.pathname === appServicePaths.host
    ? "host"
    : method === "POST" && url.pathname === appServicePaths.fleetRead
    ? "fleet.read"
    : method === "POST" && url.pathname === appServicePaths.jobs
    ? "jobs.submit"
    : method === "POST" && url.pathname === appServicePaths.relay
    ? "relay.post"
    : null
  if (service === null) {
    send(response, 404, { error: "not_found" })
    return true
  }
  const header = request.headers[hubHeaders.app]
  const app = Schema.decodeUnknownOption(AppIdSchema)(header)
  if (Option.isNone(app)) {
    send(response, 401, { code: "unauthorized" })
    return true
  }
  const verified = await context.runtime.runPromiseExit(context.tokens.verify(app.value, request.headers.authorization))
  if (verified._tag === "Failure") {
    send(response, 401, { code: "unauthorized" })
    return true
  }
  const registered = await context.runtime.runPromiseExit(context.registry.apps)
  const manifest = registered._tag === "Success"
    ? registered.value.find((entry) => entry.id === app.value)?.state.manifest ?? null
    : null
  if (manifest === null || !manifest.services.includes(service)) {
    send(response, 403, { code: "undeclared" })
    return true
  }

  const answer = <A, X>(effect: Effect.Effect<A, X, R>, encode: (value: A) => Schema.Json) =>
    context.runtime.runPromiseExit(effect).then((exit) => {
      if (exit._tag === "Success") {
        send(response, 200, encode(exit.value))
        return
      }
      const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
      const error: unknown = failure !== undefined && failure._tag === "Fail" ? failure.error : undefined
      if (Schema.is(AppServiceRefused)(error)) {
        send(response, error.code === "rejected" ? 409 : 503, { code: error.code })
      } else if (Schema.is(GrantInvalid)(error)) send(response, 403, { code: grantRefusal(error) })
      else if (failure !== undefined) send(response, 400, { code: "rejected" })
      else send(response, 500, { code: "unavailable" })
    })

  switch (service) {
    case "host":
      await answer(Effect.succeed(context.host), Schema.encodeSync(HostInfo))
      return true
    case "fleet.read":
      await answer(Effect.flatMap(context.readJson(FleetReadRequest), context.fleetRead), (json) => json)
      return true
    case "jobs.submit":
      await answer(
        Effect.gen(function*() {
          const submission = yield* context.readJson(JobSubmission)
          const caller = yield* context.grants.use({ grant: submission.grant, app: app.value, purpose: "spend" })
          return yield* context.submitJob(submission.payload, caller)
        }),
        Schema.encodeSync(JobAccepted)
      )
      return true
    case "relay.post":
      await answer(
        Effect.gen(function*() {
          const post = yield* context.readJson(RelayPost)
          const caller = post.grant === null
            ? null
            : yield* context.grants.use({ grant: post.grant, app: app.value, purpose: "write" })
          yield* context.relayPost({ kind: post.kind, text: post.text }, { app: app.value, caller })
          return {}
        }),
        (empty) => empty
      )
      return true
  }
}
