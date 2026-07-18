/** Session-bound, single-use Atlassian browser OAuth grants backed by shared local profiles. @module */

import {
  type AccessibleResource,
  buildAuthUrl,
  computeCodeChallenge,
  CONFLUENCE_SCOPES,
  exchangeCodeForTokens,
  generateCodeVerifier,
  getAccessibleResources,
  getUserInfo,
  JIRA_SCOPES,
  type TokenResponse,
  type UserInfo
} from "@knpkv/atlassian-common/auth"
import {
  CONFLUENCE_REQUIRED_SCOPES,
  getAuthPath,
  getOAuthConfigPath,
  getProfilesPath,
  HomeDirectoryLive,
  JIRA_REQUIRED_SCOPES,
  loadOAuthConfig,
  type OAuthConfig,
  type OAuthToken,
  saveOAuthConfig,
  saveProfileToken,
  writeSecureFile
} from "@knpkv/atlassian-common/config"
import * as Clock from "effect/Clock"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as HttpClient from "effect/unstable/http/HttpClient"

import {
  type AtlassianOAuthGrantExchangeResponse,
  AtlassianOAuthGrantId,
  type AtlassianOAuthGrantStartResponse,
  AtlassianOAuthSite,
  type DiscoveredAtlassianProfile
} from "../../../api/plugins.js"
import type { SessionId, WorkspaceId } from "../../../domain/identifiers.js"
import {
  ApplicationConflict,
  ApplicationInvalidRequest,
  ApplicationResourceNotFound,
  ApplicationServiceUnavailable
} from "../../api/ApplicationServices.js"

const ATLASSIAN_CALLBACK_PATH = "/services/oauth/atlassian/callback"
const GRANT_TTL_MILLISECONDS = 10 * 60 * 1_000
const MAXIMUM_PENDING_GRANTS = 20
const MAXIMUM_ACCESSIBLE_SITES = 100
const AUTH_STORE_NAMES: ReadonlyArray<string> = ["jira-cli", "confluence-to-markdown"]
const ATLASSIAN_SCOPES = Array.from(new Set([...JIRA_SCOPES, ...CONFLUENCE_SCOPES]))
const REQUIRED_SHARED_SITE_SCOPES = [
  ...JIRA_REQUIRED_SCOPES.filter((scope) => scope.includes(":jira")),
  ...CONFLUENCE_REQUIRED_SCOPES.filter((scope) => scope.includes(":confluence"))
]

interface GrantOwner {
  readonly sessionId: SessionId
  readonly workspaceId: WorkspaceId
}

interface AuthorizationGrant extends GrantOwner {
  readonly _tag: "authorization"
  readonly codeVerifier: string
  readonly config: OAuthConfig
  readonly createdAtMilliseconds: number
  readonly redirectUri: string
}

interface SiteSelectionGrant extends GrantOwner {
  readonly _tag: "site-selection"
  readonly config: OAuthConfig
  readonly createdAtMilliseconds: number
  readonly sites: ReadonlyArray<AccessibleResource>
  readonly tokens: TokenResponse
  readonly user: UserInfo
}

type PendingGrant = AuthorizationGrant | SiteSelectionGrant
type PendingGrants = ReadonlyMap<AtlassianOAuthGrantId, PendingGrant>

/** Inputs bound to the owner session that starts or resumes an OAuth grant. */
export interface AtlassianOAuthGrantOwner extends GrantOwner {}

/** Injectable operations used by plugin administration without exposing OAuth secrets. */
export interface AtlassianOAuthGrantOperations {
  readonly start: (
    owner: AtlassianOAuthGrantOwner,
    publicOrigin: string
  ) => Effect.Effect<AtlassianOAuthGrantStartResponse, ApplicationConflict | ApplicationServiceUnavailable>
  readonly exchange: (
    owner: AtlassianOAuthGrantOwner,
    grantId: AtlassianOAuthGrantId,
    code: string
  ) => Effect.Effect<
    AtlassianOAuthGrantExchangeResponse,
    ApplicationInvalidRequest | ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
  readonly complete: (
    owner: AtlassianOAuthGrantOwner,
    grantId: AtlassianOAuthGrantId,
    cloudId: string
  ) => Effect.Effect<
    DiscoveredAtlassianProfile,
    ApplicationInvalidRequest | ApplicationResourceNotFound | ApplicationServiceUnavailable
  >
  /** Internal observability used to prove scheduled secret expiry. */
  readonly pendingGrantCount: Effect.Effect<number>
}

interface StoredFileSnapshot {
  readonly content: string | null
  readonly path: string
}

const unavailable = (): ApplicationServiceUnavailable => new ApplicationServiceUnavailable({ retryAt: null })

const isExpired = (grant: PendingGrant, nowMilliseconds: number): boolean =>
  nowMilliseconds - grant.createdAtMilliseconds >= GRANT_TTL_MILLISECONDS

const activeGrants = (grants: PendingGrants, nowMilliseconds: number): Map<AtlassianOAuthGrantId, PendingGrant> =>
  new Map([...grants].filter(([, grant]) => !isExpired(grant, nowMilliseconds)))

const sameOwner = (grant: GrantOwner, owner: AtlassianOAuthGrantOwner): boolean =>
  grant.sessionId === owner.sessionId && grant.workspaceId === owner.workspaceId

const callbackUrl = (publicOrigin: string): string => `${publicOrigin}${ATLASSIAN_CALLBACK_PATH}`

const callbackPort = (publicOrigin: string): number => {
  const origin = new URL(publicOrigin)
  if (origin.port.length > 0) return Number(origin.port)
  return origin.protocol === "https:" ? 443 : 80
}

const loadSharedOAuthConfig = Effect.fn("AtlassianOAuthGrants.loadSharedOAuthConfig")(function*() {
  for (const storeName of AUTH_STORE_NAMES) {
    const config = yield* loadOAuthConfig(storeName)
    if (config !== null) return config
  }
  return null
})

const takeGrant = Effect.fn("AtlassianOAuthGrants.takeGrant")(function*(
  grants: Ref.Ref<PendingGrants>,
  grantId: AtlassianOAuthGrantId,
  owner: AtlassianOAuthGrantOwner,
  expectedPhase: PendingGrant["_tag"]
) {
  const nowMilliseconds = yield* Clock.currentTimeMillis
  return yield* Ref.modify(grants, (current): readonly [PendingGrant | null, PendingGrants] => {
    const active = activeGrants(current, nowMilliseconds)
    const grant = active.get(grantId)
    if (grant === undefined || grant._tag !== expectedPhase || !sameOwner(grant, owner)) {
      return [null, active]
    }
    active.delete(grantId)
    return [grant, active]
  })
})

const decodeSites = Effect.fn("AtlassianOAuthGrants.decodeSites")(function*(sites: ReadonlyArray<AccessibleResource>) {
  if (sites.length === 0 || sites.length > MAXIMUM_ACCESSIBLE_SITES) return yield* unavailable()
  return yield* Effect.forEach(sites, (site) =>
    Schema.decodeUnknownEffect(AtlassianOAuthSite)({
      cloudId: site.id,
      name: site.name,
      siteUrl: site.url
    }).pipe(Effect.mapError(unavailable)))
})

const supportsSharedProducts = (site: AccessibleResource): boolean =>
  REQUIRED_SHARED_SITE_SCOPES.every((scope) => site.scopes.includes(scope))

const captureFile = Effect.fn("AtlassianOAuthGrants.captureFile")(function*(filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const exists = yield* fileSystem.exists(filePath).pipe(Effect.catch(() => Effect.succeed(false)))
  return {
    path: filePath,
    content: exists ? yield* fileSystem.readFileString(filePath) : null
  } satisfies StoredFileSnapshot
})

const captureAuthStore = Effect.fn("AtlassianOAuthGrants.captureAuthStore")(function*(storeName: string) {
  const paths = yield* Effect.all([
    getOAuthConfigPath(storeName),
    getProfilesPath(storeName),
    getAuthPath(storeName)
  ])
  return yield* Effect.forEach(paths, captureFile)
})

const restoreFile = Effect.fn("AtlassianOAuthGrants.restoreFile")(function*(snapshot: StoredFileSnapshot) {
  const fileSystem = yield* FileSystem.FileSystem
  if (snapshot.content !== null) return yield* writeSecureFile(snapshot.path, snapshot.content)
  const exists = yield* fileSystem.exists(snapshot.path).pipe(Effect.catch(() => Effect.succeed(false)))
  if (exists) yield* fileSystem.remove(snapshot.path)
})

const restoreAuthStores = Effect.fn("AtlassianOAuthGrants.restoreAuthStores")(function*(
  snapshots: ReadonlyArray<ReadonlyArray<StoredFileSnapshot>>
) {
  yield* Effect.forEach(snapshots.flat(), restoreFile, { concurrency: 1 })
})

const restoreGrantAfterSaveFailure = Effect.fn("AtlassianOAuthGrants.restoreAfterSaveFailure")(function*(
  grants: Ref.Ref<PendingGrants>,
  grantId: AtlassianOAuthGrantId,
  grant: SiteSelectionGrant
) {
  const nowMilliseconds = yield* Clock.currentTimeMillis
  yield* Ref.update(grants, (current) => {
    const active = activeGrants(current, nowMilliseconds)
    if (!isExpired(grant, nowMilliseconds)) active.set(grantId, grant)
    return active
  })
})

/** Build one process-local grant manager over Effect platform services. */
export const makeAtlassianOAuthGrants = Effect.fn("AtlassianOAuthGrants.make")(function*() {
  const cryptoService = yield* Crypto.Crypto
  const fileSystem = yield* FileSystem.FileSystem
  const httpClient = yield* HttpClient.HttpClient
  const path = yield* Path.Path
  const scope = yield* Scope.Scope
  const grants = yield* Ref.make<PendingGrants>(new Map())
  const localStorageLayer = Layer.mergeAll(
    HomeDirectoryLive,
    Layer.succeed(FileSystem.FileSystem, fileSystem),
    Layer.succeed(Path.Path, path)
  )
  const providerHttpLayer = Layer.succeed(HttpClient.HttpClient, httpClient)
  const scheduleExpiry = (
    grantId: AtlassianOAuthGrantId,
    createdAtMilliseconds: number,
    phase: PendingGrant["_tag"]
  ): Effect.Effect<void> =>
    Effect.sleep(GRANT_TTL_MILLISECONDS).pipe(
      Effect.andThen(
        Ref.update(grants, (current) => {
          const grant = current.get(grantId)
          if (grant?._tag === phase && grant.createdAtMilliseconds === createdAtMilliseconds) {
            const next = new Map(current)
            next.delete(grantId)
            return next
          }
          return current
        })
      ),
      Effect.forkIn(scope),
      Effect.asVoid
    )

  const start: AtlassianOAuthGrantOperations["start"] = Effect.fn("AtlassianOAuthGrants.start")(function*(
    owner,
    publicOrigin
  ) {
    const redirectUri = callbackUrl(publicOrigin)
    const config = yield* loadSharedOAuthConfig().pipe(
      Effect.provide(localStorageLayer),
      Effect.mapError(unavailable)
    )
    if (config === null) return { _tag: "configuration-required", callbackUrl: redirectUri }

    const stateBytes = yield* cryptoService.randomBytes(32).pipe(Effect.mapError(unavailable))
    const grantId = yield* Schema.decodeUnknownEffect(AtlassianOAuthGrantId)(Encoding.encodeBase64Url(stateBytes)).pipe(
      Effect.mapError(unavailable)
    )
    const codeVerifier = yield* generateCodeVerifier().pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(unavailable)
    )
    const codeChallenge = yield* computeCodeChallenge(codeVerifier).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(unavailable)
    )
    const createdAtMilliseconds = yield* Clock.currentTimeMillis
    const didInsert = yield* Ref.modify(grants, (current): readonly [boolean, PendingGrants] => {
      const active = activeGrants(current, createdAtMilliseconds)
      if (active.size >= MAXIMUM_PENDING_GRANTS) return [false, active]
      active.set(grantId, {
        _tag: "authorization",
        ...owner,
        codeVerifier,
        config,
        createdAtMilliseconds,
        redirectUri
      })
      return [true, active]
    })
    if (!didInsert) return yield* new ApplicationConflict()
    yield* scheduleExpiry(grantId, createdAtMilliseconds, "authorization")

    return {
      _tag: "ready",
      authorizationUrl: buildAuthUrl({
        clientId: config.clientId,
        state: grantId,
        port: callbackPort(publicOrigin),
        redirectUri,
        scopes: ATLASSIAN_SCOPES,
        codeChallenge
      }),
      callbackUrl: redirectUri
    }
  })

  const exchange: AtlassianOAuthGrantOperations["exchange"] = Effect.fn("AtlassianOAuthGrants.exchange")(function*(
    owner,
    grantId,
    code
  ) {
    const pending = yield* takeGrant(grants, grantId, owner, "authorization")
    if (pending === null || pending._tag !== "authorization") return yield* new ApplicationResourceNotFound()
    const tokens = yield* exchangeCodeForTokens(code, pending.config, {
      port: callbackPort(new URL(pending.redirectUri).origin),
      redirectUri: pending.redirectUri,
      codeVerifier: pending.codeVerifier
    }).pipe(Effect.provide(providerHttpLayer), Effect.mapError(unavailable))
    const [sites, user] = yield* Effect.all([
      getAccessibleResources(tokens.access_token),
      getUserInfo(tokens.access_token)
    ]).pipe(Effect.provide(providerHttpLayer), Effect.mapError(unavailable))
    const supportedSites = sites.filter(supportsSharedProducts)
    const safeSites = yield* decodeSites(supportedSites)
    const createdAtMilliseconds = yield* Clock.currentTimeMillis
    yield* Ref.update(grants, (current) => {
      const active = activeGrants(current, createdAtMilliseconds)
      active.set(grantId, {
        _tag: "site-selection",
        ...owner,
        config: pending.config,
        createdAtMilliseconds,
        sites: supportedSites,
        tokens,
        user
      })
      return active
    })
    yield* scheduleExpiry(grantId, createdAtMilliseconds, "site-selection")
    const accountEmail = user.email.trim()
    return {
      grantId,
      accountName: user.name,
      accountEmail: accountEmail.length === 0 ? null : accountEmail,
      sites: safeSites
    }
  })

  const complete: AtlassianOAuthGrantOperations["complete"] = Effect.fn("AtlassianOAuthGrants.complete")(function*(
    owner,
    grantId,
    cloudId
  ) {
    const pending = yield* takeGrant(grants, grantId, owner, "site-selection")
    if (pending === null || pending._tag !== "site-selection") return yield* new ApplicationResourceNotFound()
    const site = pending.sites.find((candidate) => candidate.id === cloudId)
    if (site === undefined) return yield* new ApplicationInvalidRequest()
    const nowMilliseconds = yield* Clock.currentTimeMillis
    const token: OAuthToken = {
      access_token: pending.tokens.access_token,
      refresh_token: pending.tokens.refresh_token,
      expires_at: nowMilliseconds + pending.tokens.expires_in * 1_000,
      scope: pending.tokens.scope,
      cloud_id: site.id,
      site_url: site.url,
      user: {
        account_id: pending.user.account_id,
        name: pending.user.name,
        email: pending.user.email
      }
    }
    const snapshots = yield* Effect.forEach(AUTH_STORE_NAMES, captureAuthStore).pipe(
      Effect.provide(localStorageLayer),
      Effect.mapError(unavailable)
    )
    const profiles = yield* Effect.forEach(AUTH_STORE_NAMES, (storeName) =>
      Effect.gen(function*() {
        yield* saveOAuthConfig(storeName, pending.config)
        return yield* saveProfileToken(storeName, token)
      }), { concurrency: 1 }).pipe(
        Effect.provide(localStorageLayer),
        Effect.tapError(() =>
          restoreAuthStores(snapshots).pipe(
            Effect.provide(localStorageLayer),
            Effect.catch(() => Effect.void)
          )
        ),
        Effect.tapError(() => restoreGrantAfterSaveFailure(grants, grantId, pending)),
        Effect.mapError(unavailable),
        Effect.uninterruptible
      )
    const profile = profiles[0]
    if (profile === undefined) return yield* unavailable()
    const accountEmail = pending.user.email.trim()
    return {
      profileId: profile.id,
      name: profile.name,
      siteUrl: token.site_url,
      cloudId: token.cloud_id,
      accountName: pending.user.name,
      accountEmail: accountEmail.length === 0 ? null : accountEmail,
      status: "valid",
      providers: ["jira", "confluence"]
    }
  })

  return {
    start,
    exchange,
    complete,
    pendingGrantCount: Ref.get(grants).pipe(Effect.map((current) => current.size))
  } satisfies AtlassianOAuthGrantOperations
})
