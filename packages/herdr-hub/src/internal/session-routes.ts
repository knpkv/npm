/**
 * The hub's login routes, under `/v1/session`:
 *
 * - `GET /v1/session` (tailnet hub and loopback listeners): who the caller is and whether they are logged
 *   in, with the session's CSRF token when they are. Logged out, it says whether a session the request carried
 *   has ended, and over Tailscale whether the caller is on a fleet machine: the login gate draws both.
 * - `POST /v1/session/tailscale` (tailnet hub only): logs the WhoIs login in on its node. The session token
 *   goes in a `__Host-` cookie, which only this hostname's https origin can set or read.
 * - `POST /v1/session/local-code` (loopback only): `herdr-hub login` trades the hub's CLI token for a
 *   one-time code. A request with an `Origin` is a browser page, never the CLI, and is refused.
 * - `POST /v1/session/local` (loopback only): the page spends that code for a local session, in its own
 *   HttpOnly cookie. Cookies don't separate ports, so every local server sees it, but each is the user's own
 *   process, which could run `herdr-hub login` itself.
 * - `POST /v1/session/logout`: needs the session's CSRF token in `x-herdr-csrf`; clears the cookie.
 *
 * Both listeners carry the session in a cookie, so every page request and the terminal WebSocket send it.
 *
 * A login route on the wrong listener, and `/v1/session` on a listener without sessions, answer 404.
 * Nothing here decides access to other routes; it only opens and ends sessions.
 *
 * @module
 */
import type { HostConfiguration } from "@knpkv/herdr-fleet/model"
import { Effect, Redacted, Schema } from "effect"
import type { ListenerMode } from "./listener.js"
import type { makeLocalLogin } from "./local-login.js"
import { csrfFor, csrfMatches, type makePersonSessions, type OpenSession } from "./person-sessions.js"

/** The tailnet session cookie. `__Host-` keeps any other service on the hostname from setting it. */
export const sessionCookieName = "__Host-herdr_session"

/** The loopback session cookie. Plain http can't set a `__Host-` cookie, so it has its own name. */
export const localSessionCookieName = "herdr_local_session"

/** The session cookie a listener reads. */
export const sessionCookieOn = (listener: ListenerMode): string =>
  listener === "local" ? localSessionCookieName : sessionCookieName

/** The header a session's writes carry its CSRF token in. */
export const csrfHeader = "x-herdr-csrf"

/** The value of cookie `name` in a `Cookie` header, if it is there once. */
export const readCookie = (cookieHeader: string | undefined, name: string): string | undefined => {
  const values = (cookieHeader ?? "").split(";").map((part) => part.trim()).filter((part) =>
    part.startsWith(`${name}=`)
  ).map((part) => part.slice(name.length + 1))
  return values.length === 1 ? values[0] : undefined
}

const fixedCookieSeconds = 8 * 60 * 60
const slidingCookieSeconds = 7 * 24 * 60 * 60

/** The WhoIs facts a tailnet listener established; `device` is display only. */
export interface TailnetIdentity {
  readonly login: string
  readonly nodeId: string
  readonly device: string | undefined
}

/** One `/v1/session` request; its effects may need services `R` the caller provides. */
export interface SessionRequest<R = never> {
  readonly listener: ListenerMode
  readonly method: string
  readonly pathname: string
  /** The listener's session cookie's value ({@link sessionCookieOn}), if any. */
  readonly cookieToken: string | undefined
  /** The `x-herdr-csrf` header's value, if any. */
  readonly csrf: string | undefined
  /** Whether the request presented this hub start's CLI token. */
  readonly cli: boolean
  /** The `Origin` header, if any. */
  readonly origin: string | undefined
  /** The `tailscale-user-login` header, if any. On loopback it names no one, so login routes refuse it. */
  readonly headerLogin: string | undefined
  /** Fails when a write did not come from the hub's own page. */
  readonly sameOrigin: Effect.Effect<unknown, unknown, R>
  /** The caller's WhoIs identity on a tailnet listener; fails when the hub admits no such caller. */
  readonly identity: Effect.Effect<TailnetIdentity, unknown, R>
  /** The request's JSON body. */
  readonly body: Effect.Effect<unknown, unknown, R>
}

export interface SessionAnswer {
  readonly status: 200 | 401 | 403 | 404 | 503
  readonly body: Schema.Json
  readonly setCookie?: string
}

interface SessionContext {
  readonly config: Pick<HostConfiguration, "machines">
  readonly sessions: Effect.Success<ReturnType<typeof makePersonSessions>>
  readonly localLogin: Effect.Success<typeof makeLocalLogin>
}

const answer = (status: SessionAnswer["status"], body: Schema.Json, setCookie?: string): SessionAnswer =>
  setCookie === undefined ? { status, body } : { status, body, setCookie }
const notFound = answer(404, { error: "not_found" })
const forbidden = answer(403, { error: "forbidden" })
const sessionCookie = (token: string, seconds: number) =>
  `${sessionCookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${String(seconds)}`
const clearedCookie = sessionCookie("", 0)
const localCookie = (token: string, seconds: number) =>
  `${localSessionCookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${String(seconds)}`
const clearedLocalCookie = localCookie("", 0)

const CodeBody = Schema.Struct({ code: Schema.String.check(Schema.isMaxLength(128)) })

/** Whether `session` is the tailnet session bound to `identity`'s login and node. */
const boundTo = (session: OpenSession | null, identity: TailnetIdentity): session is OpenSession =>
  session?.kind === "tailscale" && session.login === identity.login && session.nodeId === identity.nodeId

/** Answers a `/v1/session` request; null for any other path. */
export const sessionRoute = Effect.fn("SessionRoutes.route")(function*<R>(
  context: SessionContext,
  request: SessionRequest<R>
) {
  if (request.pathname !== "/v1/session" && !request.pathname.startsWith("/v1/session/")) return null
  if (request.listener !== "serve" && request.listener !== "local") return notFound
  const route = `${request.method} ${request.pathname}`
  const tailnet = request.listener === "serve"
  const token = request.cookieToken
  const open = token === undefined ? null : yield* context.sessions.read(token)

  switch (route) {
    case "GET /v1/session": {
      // A cookie with no open session behind it: the session ended (expired or logged out elsewhere).
      const ended = token !== undefined && open === null
      if (!tailnet) {
        if (open?.kind !== "local" || token === undefined) {
          return answer(200, { signedIn: false, kind: "local", ended })
        }
        yield* context.sessions.touch(token)
        return answer(200, {
          signedIn: true,
          kind: "local",
          expiresAt: open.expiresAt,
          csrf: Redacted.value(yield* csrfFor(token))
        })
      }
      const identity = yield* request.identity.pipe(Effect.option)
      if (identity._tag === "None") return forbidden
      const who = identity.value.device === undefined
        ? { login: identity.value.login }
        : { login: identity.value.login, device: identity.value.device }
      if (boundTo(open, identity.value) && token !== undefined) yield* context.sessions.touch(token)
      return boundTo(open, identity.value) && token !== undefined
        ? answer(200, {
          signedIn: true,
          kind: "tailscale",
          ...who,
          expiresAt: open.expiresAt,
          csrf: Redacted.value(yield* csrfFor(token))
        })
        : answer(200, {
          signedIn: false,
          kind: "tailscale",
          ...who,
          fleetHost: context.config.machines.some(({ nodeId }) => nodeId === identity.value.nodeId),
          ended
        })
    }
    case "POST /v1/session/tailscale": {
      if (!tailnet) return notFound
      if ((yield* request.sameOrigin.pipe(Effect.option))._tag === "None") return forbidden
      const identity = yield* request.identity.pipe(Effect.option)
      if (identity._tag === "None") return forbidden
      const onMachine = context.config.machines.some(({ nodeId }) => nodeId === identity.value.nodeId)
      const minted = yield* context.sessions.mint({
        kind: "tailscale",
        login: identity.value.login,
        nodeId: identity.value.nodeId,
        sliding: !onMachine
      })
      return answer(
        200,
        { signedIn: true, kind: "tailscale", expiresAt: minted.expiresAt, csrf: Redacted.value(minted.csrf) },
        sessionCookie(Redacted.value(minted.token), onMachine ? fixedCookieSeconds : slidingCookieSeconds)
      )
    }
    case "POST /v1/session/local-code": {
      if (tailnet) return notFound
      if (!request.cli || request.origin !== undefined || request.headerLogin !== undefined) return forbidden
      return answer(200, { code: Redacted.value(yield* context.localLogin.mint) })
    }
    case "POST /v1/session/local": {
      if (tailnet) return notFound
      if (request.headerLogin !== undefined) return forbidden
      if ((yield* request.sameOrigin.pipe(Effect.option))._tag === "None") return forbidden
      const body = yield* request.body.pipe(Effect.flatMap(Schema.decodeUnknownEffect(CodeBody)), Effect.option)
      if (body._tag === "None" || !(yield* context.localLogin.exchange(body.value.code))) {
        return answer(401, { error: "code_rejected" })
      }
      const minted = yield* context.sessions.mint({ kind: "local" })
      return answer(
        200,
        { signedIn: true, kind: "local", expiresAt: minted.expiresAt, csrf: Redacted.value(minted.csrf) },
        localCookie(Redacted.value(minted.token), fixedCookieSeconds)
      )
    }
    case "POST /v1/session/logout": {
      if ((yield* request.sameOrigin.pipe(Effect.option))._tag === "None") return forbidden
      if (token === undefined || open === null || !(yield* csrfMatches(token, request.csrf))) return forbidden
      yield* context.sessions.end(token)
      return answer(200, { signedIn: false }, tailnet ? clearedCookie : clearedLocalCookie)
    }
    default:
      return notFound
  }
}, Effect.catchTag("PersonSessionsUnavailable", () => Effect.succeed(answer(503, { error: "unavailable" }))))
