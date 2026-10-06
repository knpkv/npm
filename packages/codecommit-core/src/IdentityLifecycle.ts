/**
 * The caller-identity lifecycle as one state machine: the only writer of `AppState.callerIdentities`
 * and `AppState.currentUser`. Services and handlers emit {@link IdentityEvent}s through
 * {@link applyIdentityEvent}; nothing else writes those fields.
 *
 * Per profile, the state is a {@link CallerIdentityState}: Resolved, or Unresolved with a lookup reason
 * (`CredentialsUnavailable`, `StsRejected`, `Throttled`), `RefreshAuthFailed` or `SignedOut`. A
 * profile with no entry is absent: not enabled, or not looked up yet.
 *
 * **Generation rule.** `RefreshStarted`, `SignedIn` and `SignedOut` bump the generation. Every other
 * event carries the generation of the refresh that produced it and applies only while that generation
 * is current and its profile is enabled, so a newer refresh, login or logout makes older in-flight
 * work a no-op.
 *
 * **Invariants**, after every event:
 * - a profile with an entry is in the enabled set;
 * - `currentUser` is the owner's (first enabled profile's) username when it is Resolved, else unset.
 *
 * @category Domain
 * @module
 */
import { Data, Match } from "effect"
import type { AppState, CallerIdentityState, CallerIdentityUnresolvedReason } from "./Domain.js"

/** The identity facts STS returns for a caller. */
export interface ResolvedIdentity {
  readonly accountId: string
  readonly arn: string
  readonly username: string
}

/** Why a caller-identity lookup itself failed. */
export type LookupFailureReason = Extract<
  CallerIdentityUnresolvedReason,
  { readonly _tag: "CredentialsUnavailable" | "StsRejected" | "Throttled" }
>

/** The identity slice of application state that {@link transition} owns. */
export interface IdentityLifecycle {
  readonly generation: number
  /** Enabled profiles in config order, as of the latest refresh. The first one is the owner. */
  readonly enabled: ReadonlyArray<string>
  readonly profiles: Readonly<Record<string, CallerIdentityState>>
  /** Whether a resolution pass has finished since start; until then the wire field is absent. */
  readonly firstRefreshDone: boolean
}

/** Every event that changes caller identity. */
export type IdentityEvent = Data.TaggedEnum<{
  /** A refresh read the enabled profiles from config; it bumps the generation and returns the new one. */
  RefreshStarted: { readonly enabled: ReadonlyArray<string> }
  LookupSucceeded: { readonly generation: number; readonly profile: string; readonly identity: ResolvedIdentity }
  LookupFailed: { readonly generation: number; readonly profile: string; readonly reason: LookupFailureReason }
  /** A refresh call for this profile hit an error saying its credentials are invalid. */
  RefreshAuthFailed: { readonly generation: number; readonly profile: string }
  ResolutionFinished: { readonly generation: number }
  /**
   * `aws sso login` succeeded. Without an identity (its lookup failed) the session still changed, so
   * in-flight work goes stale and the profile waits for the next refresh.
   */
  SignedIn: { readonly profile: string; readonly identity: ResolvedIdentity | undefined }
  /** `aws sso logout` succeeded. */
  SignedOut: {}
}>

export const IdentityEvent = Data.taggedEnum<IdentityEvent>()

export const initialIdentityLifecycle: IdentityLifecycle = {
  generation: 0,
  enabled: [],
  profiles: {},
  firstRefreshDone: false
}

const resolvedState = (identity: ResolvedIdentity): CallerIdentityState => ({ _tag: "Resolved", ...identity })
const unresolvedState = (reason: CallerIdentityUnresolvedReason): CallerIdentityState => ({
  _tag: "Unresolved",
  reason
})
const signedOut = unresolvedState({ _tag: "SignedOut" })
const refreshAuthFailed = unresolvedState({ _tag: "RefreshAuthFailed" })

const withProfile = (s: IdentityLifecycle, profile: string, next: CallerIdentityState): IdentityLifecycle => ({
  ...s,
  profiles: { ...s.profiles, [profile]: next }
})

/** A stamped event applies only while its generation is current and, when it names one, its profile is enabled. */
const applies = (s: IdentityLifecycle, generation: number, profile?: string): boolean =>
  generation === s.generation && (profile === undefined || s.enabled.includes(profile))

/** The single transition function over the lifecycle table. */
export const transition = (s: IdentityLifecycle, event: IdentityEvent): IdentityLifecycle =>
  Match.valueTags(event, {
    RefreshStarted: ({ enabled }): IdentityLifecycle => ({
      ...s,
      generation: s.generation + 1,
      enabled,
      profiles: Object.fromEntries(Object.entries(s.profiles).filter(([profile]) => enabled.includes(profile)))
    }),
    LookupSucceeded: ({ generation, identity, profile }) =>
      applies(s, generation, profile) ? withProfile(s, profile, resolvedState(identity)) : s,
    LookupFailed: ({ generation, profile, reason }) => {
      if (!applies(s, generation, profile)) return s
      // After a logout, failing for lack of credentials is the logout's expected result, not news.
      const current = s.profiles[profile]
      const staysSignedOut = current?._tag === "Unresolved" && current.reason._tag === "SignedOut" &&
        reason._tag === "CredentialsUnavailable"
      return staysSignedOut ? s : withProfile(s, profile, unresolvedState(reason))
    },
    RefreshAuthFailed: ({ generation, profile }) =>
      applies(s, generation, profile) && s.profiles[profile]?._tag === "Resolved"
        ? withProfile(s, profile, refreshAuthFailed)
        : s,
    ResolutionFinished: ({ generation }) => applies(s, generation) ? { ...s, firstRefreshDone: true } : s,
    SignedIn: ({ identity, profile }) => {
      const bumped = { ...s, generation: s.generation + 1 }
      return identity !== undefined && s.enabled.includes(profile)
        ? withProfile(bumped, profile, resolvedState(identity))
        : bumped
    },
    SignedOut: (): IdentityLifecycle => ({
      ...s,
      generation: s.generation + 1,
      profiles: Object.fromEntries(Object.keys(s.profiles).map((profile) => [profile, signedOut]))
    })
  })

/** The owner's username when its identity is resolved: the only source of `currentUser`. */
export const currentUserOf = (s: IdentityLifecycle): string | undefined => {
  const owner = s.enabled[0]
  const identity = owner === undefined ? undefined : s.profiles[owner]
  return identity?._tag === "Resolved" ? identity.username : undefined
}

/** The wire field: absent until something is known or a resolution pass has finished. */
const callerIdentitiesOf = (s: IdentityLifecycle): AppState["callerIdentities"] =>
  s.firstRefreshDone || Object.keys(s.profiles).length > 0 ? s.profiles : undefined

/** Project the identity slice onto the application state fields it owns. */
const project = (state: AppState, lifecycle: IdentityLifecycle): AppState => {
  const { callerIdentities: _, currentUser: __, ...rest } = state
  const callerIdentities = callerIdentitiesOf(lifecycle)
  const currentUser = currentUserOf(lifecycle)
  return {
    ...rest,
    identityLifecycle: lifecycle,
    ...(callerIdentities !== undefined && { callerIdentities }),
    ...(currentUser !== undefined && { currentUser })
  }
}

/** Apply one event and project the identity slice onto the application state it owns. */
export const applyIdentityEvent = (state: AppState, event: IdentityEvent): AppState =>
  project(state, transition(state.identityLifecycle ?? initialIdentityLifecycle, event))

/**
 * Start a refresh over the enabled profiles: apply `RefreshStarted` and return the new generation,
 * which every event this refresh produces must carry. For use with `SubscriptionRef.modify`.
 */
export const startRefresh = (state: AppState, enabled: ReadonlyArray<string>): readonly [number, AppState] => {
  const lifecycle = transition(
    state.identityLifecycle ?? initialIdentityLifecycle,
    IdentityEvent.RefreshStarted({ enabled })
  )
  return [lifecycle.generation, project(state, lifecycle)]
}

/** The state after a successful SSO login to one account, with its identity when the lookup found it. */
export const signInState = (state: AppState, profile: string, identity: ResolvedIdentity | undefined): AppState =>
  applyIdentityEvent(state, IdentityEvent.SignedIn({ profile, identity }))

/** The state after a successful SSO logout, which ends every SSO session. */
export const signOutState = (state: AppState): AppState => applyIdentityEvent(state, IdentityEvent.SignedOut())
