/** @effect-diagnostics strictEffectProvide:skip-file — each case builds its own home and site, so it is the entry point. */
/**
 * Jira through an API token or the OAuth login, and what a failed token check says.
 *
 * Each case gets its own home directory and an HttpClient that plays one Jira site, so the token
 * file, its mode and every request are observable without a network.
 */
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { JiraAuth, type JiraAuthService } from "@knpkv/jira-cli/JiraAuth"
import { Effect, FileSystem, Layer, Option, Path, Redacted } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { HomeDirectory } from "../src/services/HomeDirectory.js"
import { JiraAccess, layer as jiraAccessLayer, siteOrigin } from "../src/services/JiraAccess.js"

interface Site {
  readonly origin: string
  readonly cloudId: string | null
  readonly token: string
}

/** One Jira Cloud site: tenant info without auth, `/myself` only for the right email and token. */
const siteClient = (site: Site | "offline") =>
  HttpClient.make((request) => {
    if (site === "offline") {
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "offline" })
        })
      )
    }
    const url = new URL(request.url)
    const respond = (status: number, body: Readonly<Record<string, string>>) =>
      Effect.succeed(HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
      ))
    if (url.origin !== site.origin) return respond(404, {})
    if (url.pathname === "/_edge/tenant_info") {
      return site.cloudId === null ? respond(404, {}) : respond(200, { cloudId: site.cloudId })
    }
    if (url.pathname === "/rest/api/3/myself") {
      const expected = `Basic ${btoa(`dev@example.com:${site.token}`)}`
      return request.headers.authorization === expected
        ? respond(200, { accountId: "account-1", displayName: "Dev" })
        : respond(401, {})
    }
    return respond(404, {})
  })

const loggedOut: JiraAuthService = {
  configure: () => Effect.void,
  isConfigured: () => Effect.succeed(false),
  login: () => Effect.void,
  logout: () => Effect.void,
  getAccessToken: () => Effect.succeed(Redacted.make("")),
  getCloudId: () => Effect.succeed(""),
  getSiteUrl: () => Effect.succeed(""),
  getCurrentUser: () => Effect.succeed(null),
  getActiveProfile: () => Effect.succeed(null),
  listProfiles: () => Effect.succeed([]),
  switchProfile: () => Effect.succeed(null),
  removeProfile: () => Effect.succeed(null),
  isLoggedIn: () => Effect.succeed(false)
}

/** The stored OAuth profile holding `token`, for `cloud` and its account. */
const profileWith = (token: string, cloud: string) => ({
  id: cloud,
  name: cloud,
  token: {
    access_token: token,
    refresh_token: "refresh",
    expires_at: 4_102_444_800_000,
    scope: "write:jira-work",
    cloud_id: cloud,
    site_url: `https://${cloud}.atlassian.net`,
    user: { account_id: `${cloud}-account`, name: "OAuth Dev", email: "dev@example.com" }
  },
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z"
})

const oauthLoggedIn: JiraAuthService = {
  ...loggedOut,
  isLoggedIn: () => Effect.succeed(true),
  getAccessToken: () => Effect.succeed(Redacted.make("oauth-token")),
  getActiveProfile: () => Effect.succeed(profileWith("oauth-token", "oauth-cloud"))
}

const site: Site = { origin: "https://team.atlassian.net", cloudId: "cloud-1", token: "right-token" }

/** JiraAccess in a fresh home, over the given OAuth state and Jira site. */
const withAccess = <A, E>(
  options: { readonly oauth?: JiraAuthService; readonly site?: Site | "offline" },
  body: (home: string) => Effect.Effect<A, E, JiraAccess | FileSystem.FileSystem | Path.Path>
) =>
  Effect.scoped(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "jcf-access-" })
    const access = jiraAccessLayer.pipe(
      Layer.provide(Layer.succeed(JiraAuth, options.oauth ?? loggedOut)),
      Layer.provide(Layer.succeed(HomeDirectory, { path: home })),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, siteClient(options.site ?? site)))
    )
    return yield* body(home).pipe(Effect.provide(access))
  })).pipe(Effect.provide(NodeServices.layer))

const connect = (input: { readonly site: string; readonly token: string }) =>
  JiraAccess.use((access) =>
    access.verifyToken({ site: input.site, email: "dev@example.com", apiToken: Redacted.make(input.token) })
  )

describe("siteOrigin", () => {
  it("reads a team name, a host and a pasted Jira URL as the same site", () => {
    for (const input of ["team", "team.atlassian.net", " https://team.atlassian.net/jira/software/projects/X "]) {
      expect(siteOrigin(input)).toEqual(Option.some("https://team.atlassian.net"))
    }
  })

  // Review finding: any dotted https host was accepted, and the token sent there. A look-alike domain
  // that answers tenant_info would have collected it.
  it("accepts only Jira Cloud hosts, so a look-alike domain never receives the token", () => {
    expect(siteOrigin("https://team.atlassian.net.evil.example")).toEqual(Option.none())
    expect(siteOrigin("team.atlassian.net.evil.example")).toEqual(Option.none())
    expect(siteOrigin("https://jira.example.com")).toEqual(Option.none())
    expect(siteOrigin("https://team.atlassian.net:8443")).toEqual(Option.none())
  })

  it("refuses plain http outside loopback, credentials in the address, and nothing", () => {
    expect(siteOrigin("http://team.atlassian.net")).toEqual(Option.none())
    expect(siteOrigin("https://me:secret@team.atlassian.net")).toEqual(Option.none())
    expect(siteOrigin("  ")).toEqual(Option.none())
    expect(siteOrigin("http://127.0.0.1:8080")).toEqual(Option.some("http://127.0.0.1:8080"))
  })
})

describe("JiraAccess", () => {
  it.effect("is not connected with neither a token nor an OAuth login", () =>
    withAccess({}, () => JiraAccess.use((access) => access.connection)).pipe(
      Effect.map((connection) => expect(Option.isNone(connection)).toBe(true))
    ))

  it.effect("uses the OAuth login when there is no token file", () =>
    withAccess({ oauth: oauthLoggedIn }, () => JiraAccess.use((access) => access.connection)).pipe(
      Effect.map((connection) =>
        expect(Option.map(connection, ({ accountId, cloudId, method }) => ({ method, cloudId, accountId }))).toEqual(
          Option.some({ method: "oauth", cloudId: "oauth-cloud", accountId: "oauth-cloud-account" })
        )
      )
    ))

  // Review finding: token, site and account were read separately, so a profile switch in between could
  // pair one profile's token with another's site. A token that is not the active profile's fails closed.
  it.effect("refuses an OAuth token that does not belong to the active profile", () =>
    withAccess(
      {
        oauth: {
          ...oauthLoggedIn,
          getActiveProfile: () => Effect.succeed(profileWith("another-profile-token", "other-cloud"))
        }
      },
      () => Effect.flip(JiraAccess.use((access) => access.connection))
    ).pipe(Effect.map((error) => expect(error._tag).toBe("JiraLoginChanged"))))

  // QA-J2: the API token needs no developer console; once saved it wins over an OAuth login.
  it.effect("saves a verified token with mode 0600 and prefers it to OAuth", () =>
    withAccess({ oauth: oauthLoggedIn }, (home) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const access = yield* JiraAccess
        const verified = yield* connect({ site: "team", token: "right-token" })
        expect(verified).toMatchObject({ siteUrl: site.origin, cloudId: "cloud-1", accountId: "account-1" })
        yield* access.saveToken(verified)

        const file = path.join(home, ".jcf", "jira.json")
        expect(((yield* fs.stat(file)).mode & 0o777).toString(8)).toBe("600")
        expect(yield* fs.readDirectory(path.join(home, ".jcf"))).toEqual(["jira.json"])

        const connection = yield* access.connection
        expect(Option.map(connection, (value) => [value.method, value.siteUrl, value.accountId])).toEqual(
          Option.some(["api-token", site.origin, "account-1"])
        )
        expect(yield* access.removeToken).toBe(true)
        expect(Option.map(yield* access.connection, (value) => value.method)).toEqual(Option.some("oauth"))
      })))

  // Coord: a failed check names its cause — wrong site, bad token, or no network — never the token.
  it.effect("names a rejected token, an unknown site and an unreachable network apart", () =>
    Effect.gen(function*() {
      const rejected = yield* withAccess({}, () => Effect.flip(connect({ site: "team", token: "wrong-token" })))
      expect(rejected._tag).toBe("JiraTokenRejected")
      expect(rejected.message).toContain("https://team.atlassian.net rejected the API token for dev@example.com")
      expect(rejected.message).not.toContain("wrong-token")

      const unknown = yield* withAccess({}, () => Effect.flip(connect({ site: "other-team", token: "right-token" })))
      expect(unknown.message).toBe(
        "No Jira Cloud site answers at https://other-team.atlassian.net. Check the address in your browser's Jira tab."
      )

      const offline = yield* withAccess(
        { site: "offline" },
        () => Effect.flip(connect({ site: "team", token: "right-token" }))
      )
      expect(offline._tag).toBe("JiraUnreachable")

      const invalid = yield* withAccess({}, () => Effect.flip(connect({ site: "ftp://team", token: "right-token" })))
      expect(invalid._tag).toBe("JiraSiteInvalid")
    }))
})
