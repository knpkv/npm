/**
 * How jcf reaches Jira: an API token (`jcf auth jira token`) or the OAuth app (`jcf auth jira login`).
 *
 * **Mental model**
 *
 * - **One connection value.** {@link JiraConnection} carries the credential, the site, its cloud id and
 *   the account together, read at once, so a caller never addresses one site while authenticating or
 *   scoping against another.
 * - **The API token wins.** `~/.jcf/jira.json` is used when present; otherwise the OAuth login.
 * - **Not connected is a value**, `Option.none()`, distinct from an unreadable credential file.
 * - **The token file** is written atomically with mode `0600` and is never printed.
 *
 * @module
 */
import type { JiraApiCredential } from "@knpkv/jira-api-client"
import { JiraAuth } from "@knpkv/jira-cli/JiraAuth"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { Base64 } from "effect/encoding"
import * as FileSystem from "effect/FileSystem"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Random from "effect/Random"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { CONNECT_JIRA_COMMAND as connectJiraCommand } from "../utils/hints.js"
import { HomeDirectory } from "./HomeDirectory.js"

export { CONNECT_JIRA_COMMAND as connectJiraCommand } from "../utils/hints.js"

/** What `~/.jcf/jira.json` holds. The token stays in this file and in request headers only. */
const StoredToken = Schema.Struct({
  siteUrl: Schema.String,
  /**
   * Where requests go: the site itself for a classic token, or Atlassian's gateway for the site
   * (`https://api.atlassian.com/ex/jira/<cloudId>`) for a scoped token, which the site refuses.
   */
  apiUrl: Schema.String,
  cloudId: Schema.String,
  email: Schema.String,
  apiToken: Schema.String,
  accountId: Schema.String,
  displayName: Schema.String
})
export interface StoredToken extends Schema.Schema.Type<typeof StoredToken> {}

const decodeStoredToken = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredToken))

export interface JiraConnection {
  readonly method: "api-token" | "oauth"
  readonly credential: JiraApiCredential
  readonly cloudId: string
  readonly siteUrl: string
  /** Empty when an OAuth login has not cached its account yet. */
  readonly accountId: string
  readonly displayName: string
}

/** The Jira credential exists but cannot be read. */
export class JiraAccessUnreadable extends Data.TaggedError("JiraAccessUnreadable")<{
  readonly path: string
}> {
  override get message() {
    return `Could not read the Jira credential in ${this.path}. Run ${connectJiraCommand} to connect Jira again.`
  }
}

/** The token file could not be written. */
export class JiraTokenNotSaved extends Data.TaggedError("JiraTokenNotSaved")<{ readonly path: string }> {
  override get message() {
    return `Could not save the Jira token to ${this.path}. Check that the folder is writable.`
  }
}

/** What the user typed is not a Jira Cloud address, so no token is sent to it. */
export class JiraSiteInvalid extends Data.TaggedError("JiraSiteInvalid")<{ readonly input: string }> {
  override get message() {
    return `"${this.input}" is not a Jira Cloud address. API tokens work with Jira Cloud sites, ` +
      "which end in .atlassian.net, such as your-team.atlassian.net."
  }
}

/** The OAuth login changed between reading its token and its profile; nothing mixed is used. */
export class JiraLoginChanged extends Data.TaggedError("JiraLoginChanged")<{}> {
  override get message() {
    return "The Jira OAuth login changed while it was being read. Try again."
  }
}

/** Nothing answers as a Jira Cloud site at the address. */
export class JiraSiteNotFound extends Data.TaggedError("JiraSiteNotFound")<{ readonly siteUrl: string }> {
  override get message() {
    return `No Jira Cloud site answers at ${this.siteUrl}. Check the address in your browser's Jira tab.`
  }
}

/** The site could not be reached at all. */
export class JiraUnreachable extends Data.TaggedError("JiraUnreachable")<{ readonly siteUrl: string }> {
  override get message() {
    return `Could not reach ${this.siteUrl}. Check your network connection and try again.`
  }
}

/** The site answered, and refused the email and token. */
export class JiraTokenRejected extends Data.TaggedError("JiraTokenRejected")<{
  readonly siteUrl: string
  readonly email: string
}> {
  override get message() {
    return `${this.siteUrl} rejected the API token for ${this.email}. Use the email you sign in to Atlassian with, ` +
      "and a token from https://id.atlassian.com/manage-profile/security/api-tokens."
  }
}

export type JiraTokenVerificationError = JiraSiteInvalid | JiraSiteNotFound | JiraUnreachable | JiraTokenRejected

export interface JiraAccessContract {
  /** The current connection, or none when Jira is not connected. Re-read on every call. */
  readonly connection: Effect.Effect<Option.Option<JiraConnection>, JiraAccessUnreadable | JiraLoginChanged>
  /** Checks a site, email and token against Jira and returns what would be stored. Saves nothing. */
  readonly verifyToken: (input: {
    readonly site: string
    readonly email: string
    readonly apiToken: Redacted.Redacted<string>
  }) => Effect.Effect<StoredToken, JiraTokenVerificationError>
  readonly saveToken: (token: StoredToken) => Effect.Effect<void, JiraTokenNotSaved>
  /** Removes the token file. True when there was one. */
  readonly removeToken: Effect.Effect<boolean, JiraTokenNotSaved>
}

export class JiraAccess extends Context.Service<JiraAccess, JiraAccessContract>()("jcf/JiraAccess") {}

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"])

/**
 * The origin of a Jira Cloud site the user typed: `team`, `team.atlassian.net` and a pasted Jira URL
 * all name `https://team.atlassian.net`. Only `*.atlassian.net` over https is accepted, because the
 * token is sent to this host: a typo or a look-alike domain must fail before any credential leaves.
 * Plain http on loopback is the one exception, for stand-ins in tests.
 */
export const siteOrigin = (input: string): Option.Option<string> => {
  const trimmed = input.trim()
  if (trimmed === "") return Option.none()
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = URL.parse(withScheme)
  if (url === null || url.username !== "" || url.password !== "") return Option.none()
  if (url.protocol === "http:" && loopbackHosts.has(url.hostname)) return Option.some(url.origin)
  if (url.protocol !== "https:" || url.port !== "") return Option.none()
  const host = url.hostname.includes(".") ? url.hostname : `${url.hostname}.atlassian.net`
  return /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/u.test(host) ? Option.some(`https://${host}`) : Option.none()
}

const TenantInfo = Schema.Struct({ cloudId: Schema.NonEmptyString })
const Myself = Schema.Struct({ accountId: Schema.NonEmptyString, displayName: Schema.String })

export const layer = Layer.effect(
  JiraAccess,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const httpClient = yield* HttpClient.HttpClient
    const oauth = yield* JiraAuth
    const directory = path.join((yield* HomeDirectory).path, ".jcf")
    const file = path.join(directory, "jira.json")

    const tokenConnection = Effect.gen(function*() {
      if (!(yield* fs.exists(file))) return Option.none<JiraConnection>()
      const stored = yield* fs.readFileString(file).pipe(Effect.flatMap(decodeStoredToken))
      return Option.some<JiraConnection>({
        method: "api-token",
        credential: {
          type: "basic",
          email: stored.email,
          apiToken: Redacted.make(stored.apiToken),
          siteUrl: stored.apiUrl
        },
        cloudId: stored.cloudId,
        siteUrl: stored.siteUrl,
        accountId: stored.accountId,
        displayName: stored.displayName
      })
    }).pipe(Effect.mapError(() => new JiraAccessUnreadable({ path: file })))

    // The token is refreshed first, then site and account come from one profile object holding that
    // same token. Reading them separately could pair one profile's token with another's site.
    const oauthConnection = Effect.gen(function*() {
      if (!(yield* oauth.isLoggedIn())) return Option.none<JiraConnection>()
      const accessToken = yield* oauth.getAccessToken()
      const profile = yield* oauth.getActiveProfile()
      if (profile === null) return Option.none<JiraConnection>()
      if (profile.token.access_token !== Redacted.value(accessToken)) return yield* new JiraLoginChanged()
      const { cloud_id: cloudId, site_url: siteUrl, user } = profile.token
      return Option.some<JiraConnection>({
        method: "oauth",
        credential: { type: "oauth2", accessToken, cloudId },
        cloudId,
        siteUrl,
        accountId: user?.account_id ?? "",
        displayName: user?.name ?? ""
      })
    }).pipe(
      Effect.mapError((error): JiraAccessUnreadable | JiraLoginChanged =>
        Predicate.isTagged(error, "JiraLoginChanged")
          ? new JiraLoginChanged()
          : new JiraAccessUnreadable({ path: "the Jira OAuth login" })
      )
    )

    const connection = tokenConnection.pipe(
      Effect.flatMap((token) => Option.isSome(token) ? Effect.succeed(token) : oauthConnection)
    )

    const verifyToken: JiraAccessContract["verifyToken"] = (input) =>
      Effect.gen(function*() {
        const siteUrl = yield* Option.match(siteOrigin(input.site), {
          onNone: () => Effect.fail(new JiraSiteInvalid({ input: input.site })),
          onSome: Effect.succeed
        })
        const unreachable = () => new JiraUnreachable({ siteUrl })
        const notFound = () => new JiraSiteNotFound({ siteUrl })

        const tenant = yield* httpClient.execute(HttpClientRequest.get(`${siteUrl}/_edge/tenant_info`)).pipe(
          Effect.mapError(unreachable)
        )
        if (tenant.status !== 200) return yield* notFound()
        const { cloudId } = yield* tenant.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(TenantInfo)),
          Effect.mapError(notFound)
        )

        const authorization = `Basic ${Base64.encode(`${input.email}:${Redacted.value(input.apiToken)}`)}`
        const askMyself = (apiUrl: string) =>
          httpClient.execute(
            HttpClientRequest.get(`${apiUrl}/rest/api/3/myself`).pipe(
              HttpClientRequest.setHeader("Authorization", authorization),
              HttpClientRequest.setHeader("Accept", "application/json")
            )
          ).pipe(Effect.mapError(unreachable))
        const refused = (status: number) => status === 401 || status === 403
        // A classic token works on the site; a scoped one only through Atlassian's gateway for it.
        const gateway = `https://api.atlassian.com/ex/jira/${cloudId}`
        const onSite = yield* askMyself(siteUrl)
        const apiUrl = refused(onSite.status) ? gateway : siteUrl
        const myself = apiUrl === gateway ? yield* askMyself(gateway) : onSite
        if (refused(myself.status)) return yield* new JiraTokenRejected({ siteUrl, email: input.email })
        if (myself.status !== 200) return yield* unreachable()
        const user = yield* myself.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Myself)),
          Effect.mapError(notFound)
        )
        return {
          siteUrl,
          apiUrl,
          cloudId,
          email: input.email,
          apiToken: Redacted.value(input.apiToken),
          accountId: user.accountId,
          displayName: user.displayName
        }
      })

    // Written beside the target and renamed over it, so a reader never sees half a file and the token
    // is never readable by anyone else, not even for the moment before a chmod.
    const saveToken: JiraAccessContract["saveToken"] = (token) =>
      Effect.gen(function*() {
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
        const pending = `${file}.${yield* Random.nextIntBetween(0, 1_000_000_000)}.tmp`
        yield* fs.writeFileString(pending, JSON.stringify(token, null, 2), { mode: 0o600 })
        yield* fs.chmod(pending, 0o600)
        yield* fs.rename(pending, file).pipe(Effect.tapError(() => fs.remove(pending).pipe(Effect.ignore)))
      }).pipe(Effect.mapError(() => new JiraTokenNotSaved({ path: file })))

    const removeToken: JiraAccessContract["removeToken"] = Effect.gen(function*() {
      if (!(yield* fs.exists(file))) return false
      yield* fs.remove(file)
      return true
    }).pipe(Effect.mapError(() => new JiraTokenNotSaved({ path: file })))

    return { connection, verifyToken, saveToken, removeToken }
  })
)
