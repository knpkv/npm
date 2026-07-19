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
  loadProfiles,
  type OAuthConfig,
  type OAuthToken,
  profileIdFromToken,
  profileNameFromToken,
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
import * as Semaphore from "effect/Semaphore"
import * as HttpClient from "effect/unstable/http/HttpClient"

import {
  AtlassianOAuthGrantExchangeResponse,
  AtlassianOAuthGrantId,
  type AtlassianOAuthGrantStartResponse,
  type AtlassianOAuthProviderIntent,
  AtlassianOAuthSite,
  DiscoveredAtlassianProfile
} from "../../../api/plugins.js"
import type { SessionId, WorkspaceId } from "../../../domain/identifiers.js"
import {
  ApplicationConflict,
  ApplicationInvalidRequest,
  ApplicationResourceNotFound,
  ApplicationServiceUnavailable
} from "../../api/ApplicationServices.js"
import { CONTROL_CENTER_AUTH_STORE_NAME } from "./AtlassianProfiles.js"

const ATLASSIAN_CALLBACK_PATH = "/services/oauth/atlassian/callback"
const GRANT_TTL_MILLISECONDS = 10 * 60 * 1_000
const MAXIMUM_PENDING_GRANTS = 20
const MAXIMUM_ACCESSIBLE_SITES = 100
const JIRA_AUTH_STORE_NAME = "jira-cli"
const CONFLUENCE_AUTH_STORE_NAME = "confluence-to-markdown"

const AtlassianOAuthUserMetadata = Schema.Struct({
  account_id: Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(500)),
  name: Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(500)),
  email: Schema.Trim.check(Schema.isMaxLength(500))
})

interface GrantOwner {
  readonly sessionId: SessionId
  readonly workspaceId: WorkspaceId
}

interface AuthorizationGrant extends GrantOwner {
  readonly _tag: "authorization"
  readonly codeVerifier: string
  readonly config: OAuthConfig
  readonly createdAtMilliseconds: number
  readonly providers: AtlassianOAuthProviderIntent
  readonly redirectUri: string
}

interface ExchangeGrant extends Omit<AuthorizationGrant, "_tag"> {
  readonly _tag: "exchange"
}

interface SiteSelectionGrant extends GrantOwner {
  readonly _tag: "site-selection"
  readonly config: OAuthConfig
  readonly createdAtMilliseconds: number
  readonly providers: AtlassianOAuthProviderIntent
  readonly sites: ReadonlyArray<AccessibleResource>
  readonly tokenExpiresAtMilliseconds: number
  readonly tokens: TokenResponse
  readonly user: UserInfo
}

type PendingGrant = AuthorizationGrant | ExchangeGrant | SiteSelectionGrant
type PendingGrants = ReadonlyMap<AtlassianOAuthGrantId, PendingGrant>

/** Inputs bound to the owner session that starts or resumes an OAuth grant. */
export interface AtlassianOAuthGrantOwner extends GrantOwner {}

/** Injectable operations used by plugin administration without exposing OAuth secrets. */
export interface AtlassianOAuthGrantOperations {
  readonly start: (
    owner: AtlassianOAuthGrantOwner,
    publicOrigin: string,
    providers: AtlassianOAuthProviderIntent
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

interface AuthStoreWritePlan {
  readonly shouldWriteConfig: boolean
  readonly storeName: string
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

const sameOAuthConfig = (left: OAuthConfig, right: OAuthConfig): boolean =>
  left.clientId === right.clientId && left.clientSecret === right.clientSecret

const preservesStoredScopes = (stored: OAuthToken, replacement: OAuthToken): boolean => {
  const replacementScopes = new Set(replacement.scope.split(/\s+/).filter((scope) => scope.length > 0))
  return stored.scope.split(/\s+/).filter((scope) => scope.length > 0).every((scope) => replacementScopes.has(scope))
}

const loadSharedOAuthConfig = Effect.fn("AtlassianOAuthGrants.loadSharedOAuthConfig")(function*() {
  const [jiraConfig, confluenceConfig] = yield* Effect.all([
    loadOAuthConfig(JIRA_AUTH_STORE_NAME),
    loadOAuthConfig(CONFLUENCE_AUTH_STORE_NAME)
  ], { concurrency: 1 })
  return jiraConfig !== null && confluenceConfig !== null && sameOAuthConfig(jiraConfig, confluenceConfig)
    ? jiraConfig
    : null
})

const planAuthStoreWrite = Effect.fn("AtlassianOAuthGrants.planAuthStoreWrite")(function*(
  storeName: string,
  sharedConfig: OAuthConfig,
  token: OAuthToken
) {
  const [currentConfig, profiles] = yield* Effect.all([
    loadOAuthConfig(storeName),
    loadProfiles(storeName)
  ], { concurrency: 1 })
  const hasMatchingConfig = currentConfig !== null && sameOAuthConfig(currentConfig, sharedConfig)
  if (profiles.profiles.length > 0 && !hasMatchingConfig) return yield* unavailable()
  const existingProfile = profiles.profiles.find((profile) => profile.id === profileIdFromToken(token))
  if (existingProfile !== undefined && !preservesStoredScopes(existingProfile.token, token)) {
    return yield* unavailable()
  }
  return {
    storeName,
    shouldWriteConfig: !hasMatchingConfig
  } satisfies AuthStoreWritePlan
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

const beginExchange = Effect.fn("AtlassianOAuthGrants.beginExchange")(function*(
  grants: Ref.Ref<PendingGrants>,
  grantId: AtlassianOAuthGrantId,
  owner: AtlassianOAuthGrantOwner
) {
  const nowMilliseconds = yield* Clock.currentTimeMillis
  return yield* Ref.modify(grants, (current): readonly [AuthorizationGrant | null, PendingGrants] => {
    const active = activeGrants(current, nowMilliseconds)
    const grant = active.get(grantId)
    if (grant === undefined || grant._tag !== "authorization" || !sameOwner(grant, owner)) return [null, active]
    active.set(grantId, { ...grant, _tag: "exchange" })
    return [grant, active]
  })
})

const removeExchange = Effect.fn("AtlassianOAuthGrants.removeExchange")(function*(
  grants: Ref.Ref<PendingGrants>,
  grantId: AtlassianOAuthGrantId,
  createdAtMilliseconds: number
) {
  yield* Ref.update(grants, (current) => {
    const grant = current.get(grantId)
    if (grant?._tag !== "exchange" || grant.createdAtMilliseconds !== createdAtMilliseconds) return current
    const next = new Map(current)
    next.delete(grantId)
    return next
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

const tokenForSite = (
  tokens: TokenResponse,
  tokenExpiresAtMilliseconds: number,
  user: UserInfo,
  site: AccessibleResource
): OAuthToken => ({
  access_token: tokens.access_token,
  refresh_token: tokens.refresh_token,
  expires_at: tokenExpiresAtMilliseconds,
  scope: tokens.scope,
  cloud_id: site.id,
  site_url: site.url,
  user: {
    account_id: user.account_id,
    name: user.name,
    email: user.email
  }
})

const validateProfileMetadata = Effect.fn("AtlassianOAuthGrants.validateProfileMetadata")(function*(
  token: OAuthToken,
  providers: AtlassianOAuthProviderIntent
) {
  const accountEmail = token.user?.email ?? ""
  yield* Schema.decodeUnknownEffect(DiscoveredAtlassianProfile)({
    profileId: profileIdFromToken(token),
    name: profileNameFromToken(token),
    siteUrl: token.site_url,
    cloudId: token.cloud_id,
    accountName: token.user?.name ?? null,
    accountEmail: accountEmail.length === 0 ? null : accountEmail,
    status: "valid",
    providers
  }).pipe(Effect.mapError(unavailable))
})

type AtlassianOAuthProvider = AtlassianOAuthProviderIntent[number]

const oauthScopes: Readonly<Record<AtlassianOAuthProvider, ReadonlyArray<string>>> = {
  jira: JIRA_SCOPES,
  confluence: CONFLUENCE_SCOPES
}

const requiredSiteScopes: Readonly<Record<AtlassianOAuthProvider, ReadonlyArray<string>>> = {
  jira: JIRA_REQUIRED_SCOPES.filter((scope) => scope.includes(":jira")),
  confluence: CONFLUENCE_REQUIRED_SCOPES.filter((scope) => scope.includes(":confluence"))
}

const requiredTokenScopes: Readonly<Record<AtlassianOAuthProvider, ReadonlyArray<string>>> = {
  jira: JIRA_REQUIRED_SCOPES,
  confluence: CONFLUENCE_REQUIRED_SCOPES
}

const scopesForProviders = (providers: AtlassianOAuthProviderIntent): ReadonlyArray<string> =>
  Array.from(new Set(providers.flatMap((provider) => oauthScopes[provider])))

const supportsProducts = (site: AccessibleResource, providers: AtlassianOAuthProviderIntent): boolean =>
  providers.every((provider) => requiredSiteScopes[provider].every((scope) => site.scopes.includes(scope)))

const tokenSupportsProducts = (token: TokenResponse, providers: AtlassianOAuthProviderIntent): boolean => {
  const grantedScopes = new Set(token.scope.split(/\s+/).filter((scope) => scope.length > 0))
  return providers.every((provider) => requiredTokenScopes[provider].every((scope) => grantedScopes.has(scope)))
}

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
    if (!isExpired(grant, nowMilliseconds) && active.size < MAXIMUM_PENDING_GRANTS) active.set(grantId, grant)
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
  const profileStoreLock = yield* Semaphore.make(1)
  const localStorageLayer = Layer.mergeAll(
    HomeDirectoryLive,
    Layer.succeed(FileSystem.FileSystem, fileSystem),
    Layer.succeed(Path.Path, path)
  )
  const providerHttpLayer = Layer.succeed(HttpClient.HttpClient, httpClient)
  const scheduleExpiry = (
    grantId: AtlassianOAuthGrantId,
    createdAtMilliseconds: number
  ): Effect.Effect<void> =>
    Effect.sleep(GRANT_TTL_MILLISECONDS).pipe(
      Effect.andThen(
        Ref.update(grants, (current) => {
          const grant = current.get(grantId)
          if (grant?.createdAtMilliseconds === createdAtMilliseconds) {
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
    publicOrigin,
    providers
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
        providers,
        redirectUri
      })
      return [true, active]
    })
    if (!didInsert) return yield* new ApplicationConflict()
    yield* scheduleExpiry(grantId, createdAtMilliseconds)

    return {
      _tag: "ready",
      authorizationUrl: buildAuthUrl({
        clientId: config.clientId,
        state: grantId,
        port: callbackPort(publicOrigin),
        redirectUri,
        scopes: scopesForProviders(providers),
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
    const pending = yield* beginExchange(grants, grantId, owner)
    if (pending === null) return yield* new ApplicationResourceNotFound()
    const exchanged = yield* Effect.gen(function*() {
      const tokens = yield* exchangeCodeForTokens(code, pending.config, {
        port: callbackPort(new URL(pending.redirectUri).origin),
        redirectUri: pending.redirectUri,
        codeVerifier: pending.codeVerifier
      }).pipe(Effect.provide(providerHttpLayer), Effect.mapError(unavailable))
      if (!tokenSupportsProducts(tokens, pending.providers)) return yield* unavailable()
      const tokenExchangeAtMilliseconds = yield* Clock.currentTimeMillis
      const [sites, providerUser] = yield* Effect.all([
        getAccessibleResources(tokens.access_token),
        getUserInfo(tokens.access_token)
      ]).pipe(Effect.provide(providerHttpLayer), Effect.mapError(unavailable))
      const supportedSites = sites.filter((site) => supportsProducts(site, pending.providers))
      const safeSites = yield* decodeSites(supportedSites)
      const user = yield* Schema.decodeUnknownEffect(AtlassianOAuthUserMetadata)(providerUser).pipe(
        Effect.mapError(unavailable)
      )
      const tokenExpiresAtMilliseconds = tokenExchangeAtMilliseconds + tokens.expires_in * 1_000
      yield* Effect.forEach(
        supportedSites,
        (site) =>
          validateProfileMetadata(tokenForSite(tokens, tokenExpiresAtMilliseconds, user, site), pending.providers)
      )
      const accountEmail = user.email.length === 0 ? null : user.email
      const response = yield* Schema.decodeUnknownEffect(AtlassianOAuthGrantExchangeResponse)({
        grantId,
        accountName: user.name,
        accountEmail,
        sites: safeSites
      }).pipe(Effect.mapError(unavailable))
      return { response, sites: supportedSites, tokenExpiresAtMilliseconds, tokens, user }
    }).pipe(Effect.tapError(() => removeExchange(grants, grantId, pending.createdAtMilliseconds)))
    const nowMilliseconds = yield* Clock.currentTimeMillis
    const didTransition = yield* Ref.modify(grants, (current): readonly [boolean, PendingGrants] => {
      const active = activeGrants(current, nowMilliseconds)
      const reserved = active.get(grantId)
      if (
        reserved?._tag !== "exchange" ||
        reserved.createdAtMilliseconds !== pending.createdAtMilliseconds ||
        !sameOwner(reserved, owner)
      ) return [false, active]
      active.set(grantId, {
        _tag: "site-selection",
        ...owner,
        config: pending.config,
        createdAtMilliseconds: pending.createdAtMilliseconds,
        providers: pending.providers,
        sites: exchanged.sites,
        tokenExpiresAtMilliseconds: exchanged.tokenExpiresAtMilliseconds,
        tokens: exchanged.tokens,
        user: exchanged.user
      })
      return [true, active]
    })
    if (!didTransition) return yield* new ApplicationResourceNotFound()
    return exchanged.response
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
    const token = tokenForSite(pending.tokens, pending.tokenExpiresAtMilliseconds, pending.user, site)
    const profile = yield* profileStoreLock.withPermit(
      Effect.gen(function*() {
        const snapshots = yield* Effect.forEach([CONTROL_CENTER_AUTH_STORE_NAME], captureAuthStore).pipe(
          Effect.provide(localStorageLayer),
          Effect.tapError(() => restoreGrantAfterSaveFailure(grants, grantId, pending)),
          Effect.mapError(unavailable)
        )
        return yield* Effect.gen(function*() {
          const plan = yield* planAuthStoreWrite(CONTROL_CENTER_AUTH_STORE_NAME, pending.config, token)
          if (plan.shouldWriteConfig) yield* saveOAuthConfig(plan.storeName, pending.config)
          return yield* saveProfileToken(plan.storeName, token)
        }).pipe(
          Effect.provide(localStorageLayer),
          Effect.tapError(() =>
            restoreAuthStores(snapshots).pipe(
              Effect.provide(localStorageLayer),
              Effect.catch(() => Effect.void)
            )
          ),
          Effect.tapError(() => restoreGrantAfterSaveFailure(grants, grantId, pending)),
          Effect.mapError(unavailable)
        )
      })
    ).pipe(Effect.uninterruptible)
    const accountEmail = pending.user.email
    return {
      profileId: profile.id,
      name: profile.name,
      siteUrl: token.site_url,
      cloudId: token.cloud_id,
      accountName: pending.user.name,
      accountEmail: accountEmail.length === 0 ? null : accountEmail,
      status: "valid",
      providers: pending.providers
    }
  })

  return {
    start,
    exchange,
    complete,
    pendingGrantCount: Ref.get(grants).pipe(Effect.map((current) => current.size))
  } satisfies AtlassianOAuthGrantOperations
})
