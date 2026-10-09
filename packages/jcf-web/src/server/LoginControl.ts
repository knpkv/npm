/**
 * The route `jcf web login` asks for a fresh one-time link on.
 *
 * Only a caller holding the control token gets one; jcf-web writes that token, owner-only, to
 * `~/.jcf/web.json` (see `WebControl` in `@knpkv/jira-clockify`). The link is minted exactly like the
 * startup link: one use, within a minute.
 *
 * @module
 */
import { credentialValuesEqual } from "@knpkv/browser-pairing"
import * as OwnerSession from "@knpkv/browser-pairing/owner-session"
import { Effect, Redacted } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

/** The bearer credential in an `authorization` header, compared in fixed time against the expected one. */
const presentsToken = (header: string | undefined, expected: string): boolean =>
  header !== undefined && header.startsWith("Bearer ") && credentialValuesEqual(header.slice(7), expected)

export const loginControlRouter = (token: Redacted.Redacted<string>) =>
  HttpRouter.use((router) =>
    router.add(
      "POST",
      "/control/login",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (!presentsToken(request.headers["authorization"], Redacted.value(token))) {
          return HttpServerResponse.empty({ status: 401 })
        }
        const session = yield* OwnerSession.OwnerSession
        const code = yield* session.mintBootstrapCode.pipe(Effect.orDie)
        return yield* HttpServerResponse.json({ url: OwnerSession.bootstrapUrl(session.browserOrigin, code) })
      })
    )
  )
