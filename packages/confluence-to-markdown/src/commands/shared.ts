/**
 * Shared utilities for CLI commands.
 */
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { ConfluenceAuth } from "../ConfluenceAuth.js"
import { ConfigError } from "../ConfluenceError.js"

type AuthConfigValue =
  | { readonly type: "token"; readonly email: string; readonly token: string }
  | { readonly type: "oauth2"; readonly accessToken: string; readonly cloudId: string }

/**
 * Scheme + host, so `https://site.atlassian.net/wiki` and `.../wiki/spaces/X`
 * compare equal. `undefined` when the value is not a URL at all.
 *
 * Shared deliberately: every site-mismatch guard has to normalise origins the
 * same way, or two of them disagree about whether a write is on the right site.
 *
 * @category Utilities
 */
export const originOf = (input: string): string | undefined => {
  try {
    const url = new URL(input.trim())
    return `${url.protocol}//${url.host}`
  } catch {
    return undefined
  }
}

const AuthConfig = Config.all({
  apiKey: Config.string("CONFLUENCE_API_KEY"),
  email: Config.string("CONFLUENCE_EMAIL")
})

/**
 * Get authentication config from env vars or OAuth.
 */
export const getAuth = () =>
  Effect.gen(function*() {
    // 1. Try env vars first (backwards compat)
    const envAuth = yield* AuthConfig.pipe(
      Effect.map(({ apiKey, email }): AuthConfigValue => ({ type: "token", email, token: apiKey })),
      Effect.option
    )

    if (Option.isSome(envAuth)) {
      return envAuth.value
    }

    // 2. Try OAuth token
    const auth = yield* ConfluenceAuth
    const accessToken = yield* auth.getAccessToken()
    const cloudId = yield* auth.getCloudId()

    return { type: "oauth2", accessToken, cloudId } satisfies AuthConfigValue
  })

/**
 * Refuse a `--base-url` that is not the site the request will actually reach.
 *
 * Under OAuth the base URL is not the routing input at all: the client addresses
 * `api.atlassian.com/ex/confluence/{cloudId}` and ignores `config.baseUrl`
 * entirely, so a `--base-url` naming another site is silently discarded and the
 * call lands on the active profile's site. Content ids are per-site, so that
 * turns a wrong-site `folder create` into a folder on the wrong site, and a
 * `folder get` into a *different* folder rather than a 404.
 *
 * API-token auth does route by `baseUrl`, so there is nothing to reconcile.
 *
 * @category Utilities
 */
export const assertSiteMatchesAuth = (
  auth: AuthConfigValue,
  baseUrl: string
): Effect.Effect<void, ConfigError, ConfluenceAuth> =>
  Effect.gen(function*() {
    if (auth.type === "token") return

    const service = yield* ConfluenceAuth
    // Fail closed. A guard that cannot read the profile has not established the
    // site identity, and holding a token proves nothing about which site it
    // belongs to — proceeding would let exactly the mismatch this exists to stop
    // through on a transient filesystem or decode error.
    const profile = yield* service.getActiveProfile().pipe(
      Effect.mapError((cause) =>
        new ConfigError({
          message: `Could not read the active auth profile to confirm which site this would act on: ${cause}. ` +
            `Re-run 'confluence auth status' to check the profile store.`
        })
      )
    )
    const siteUrl = profile?.token.site_url
    if (siteUrl === undefined) {
      return yield* Effect.fail(
        new ConfigError({
          message: `The active auth profile names no site, so the site this would act on cannot be confirmed. ` +
            `Re-run 'confluence auth login'.`
        })
      )
    }

    const requested = originOf(baseUrl)
    const active = originOf(siteUrl)
    // Fail closed on either side: an origin that will not parse is an origin
    // this has not verified, and "unverified" must not read as "matches".
    if (requested === undefined || active === undefined) {
      return yield* Effect.fail(
        new ConfigError({
          message: `Could not compare the requested site (${JSON.stringify(baseUrl)}) with the active profile's ` +
            `site (${JSON.stringify(siteUrl)}); one of them is not a usable URL, so the site this would act on ` +
            `cannot be confirmed.`
        })
      )
    }
    if (requested === active) return

    return yield* Effect.fail(
      new ConfigError({
        message: `--base-url names ${requested}, but the active auth profile is signed in to ${active}. ` +
          `OAuth requests route to the profile's site, so this would act on ${active} instead. ` +
          `Switch with 'confluence auth use <profile>' or pass a URL from ${active}.`
      })
    )
  })
