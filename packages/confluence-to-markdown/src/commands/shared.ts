/**
 * Shared utilities for CLI commands.
 */
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { ConfluenceAuth } from "../ConfluenceAuth.js"

type AuthConfigValue =
  | { readonly type: "token"; readonly email: string; readonly token: string }
  | { readonly type: "oauth2"; readonly accessToken: string; readonly cloudId: string }

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
