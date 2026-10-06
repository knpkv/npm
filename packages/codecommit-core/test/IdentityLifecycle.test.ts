/**
 * The caller-identity lifecycle table (workers/arch2.522.states.md v2), cell by cell: every state ×
 * every event, the stale-generation and disabled-profile versions of every stamped event, and the two
 * invariants after every cell.
 */
import { describe, expect, it } from "@effect/vitest"
import type { AppState, CallerIdentityState } from "../src/Domain.js"
import {
  applyIdentityEvent,
  IdentityEvent,
  type IdentityLifecycle,
  type ResolvedIdentity,
  transition
} from "../src/IdentityLifecycle.js"

const generation = 7
// "owner" is the first enabled profile and owns currentUser; "subject" is the profile under test.
const owner = "owner"
const subject = "subject"
const other = "other"

const oldIdentity: ResolvedIdentity = {
  accountId: "111111111111",
  arn: "arn:aws:sts::111111111111:assumed-role/R/old",
  username: "old"
}
const newIdentity: ResolvedIdentity = {
  accountId: "111111111111",
  arn: "arn:aws:sts::111111111111:assumed-role/R/new",
  username: "new"
}

type StateName = "Absent" | "Resolved" | "LookupFailed" | "AuthFailed" | "SignedOut"

const stateOf = {
  Absent: undefined,
  Resolved: { _tag: "Resolved", ...oldIdentity },
  LookupFailed: { _tag: "Unresolved", reason: { _tag: "StsRejected" } },
  AuthFailed: { _tag: "Unresolved", reason: { _tag: "RefreshAuthFailed" } },
  SignedOut: { _tag: "Unresolved", reason: { _tag: "SignedOut" } }
} satisfies Record<StateName, CallerIdentityState | undefined>

const lifecycleWith = (subjectState: CallerIdentityState | undefined): IdentityLifecycle => ({
  generation,
  enabled: [owner, subject, other],
  profiles: {
    [owner]: { _tag: "Resolved", ...oldIdentity },
    ...(subjectState !== undefined && { [subject]: subjectState })
  },
  firstRefreshDone: false
})

const resolvedNew: CallerIdentityState = { _tag: "Resolved", ...newIdentity }
const failed = (reason: "CredentialsUnavailable" | "Throttled"): CallerIdentityState => ({
  _tag: "Unresolved",
  reason: { _tag: reason }
})

interface Column {
  readonly name: string
  readonly event: IdentityEvent
  /** Expected subject state, per starting state; `"same"` means unchanged. */
  readonly expect: (from: StateName) => CallerIdentityState | undefined | "same"
  readonly bumps: boolean
}

const columns: ReadonlyArray<Column> = [
  {
    name: "RefreshStarted (profile enabled)",
    event: IdentityEvent.RefreshStarted({ enabled: [owner, subject, other] }),
    expect: () => "same",
    bumps: true
  },
  {
    name: "RefreshStarted (profile disabled)",
    event: IdentityEvent.RefreshStarted({ enabled: [owner, other] }),
    expect: () => undefined,
    bumps: true
  },
  {
    name: "LookupSucceeded",
    event: IdentityEvent.LookupSucceeded({ generation, profile: subject, identity: newIdentity }),
    expect: () => resolvedNew,
    bumps: false
  },
  {
    name: "LookupFailed(Throttled)",
    event: IdentityEvent.LookupFailed({ generation, profile: subject, reason: { _tag: "Throttled" } }),
    expect: () => failed("Throttled"),
    bumps: false
  },
  {
    name: "LookupFailed(CredentialsUnavailable)",
    event: IdentityEvent.LookupFailed({ generation, profile: subject, reason: { _tag: "CredentialsUnavailable" } }),
    // After a logout, lacking credentials is the logout's expected result.
    expect: (from) => from === "SignedOut" ? "same" : failed("CredentialsUnavailable"),
    bumps: false
  },
  {
    name: "RefreshAuthFailed",
    event: IdentityEvent.RefreshAuthFailed({ generation, profile: subject }),
    expect: (from) => from === "Resolved" ? stateOf.AuthFailed : "same",
    bumps: false
  },
  {
    name: "ResolutionFinished",
    event: IdentityEvent.ResolutionFinished({ generation }),
    expect: () => "same",
    bumps: false
  },
  {
    name: "SignedIn (this profile)",
    event: IdentityEvent.SignedIn({ profile: subject, identity: newIdentity }),
    expect: () => resolvedNew,
    bumps: true
  },
  {
    // The login succeeded but its identity lookup failed: the session still changed.
    name: "SignedIn (this profile, no identity)",
    event: IdentityEvent.SignedIn({ profile: subject, identity: undefined }),
    // The login may have changed the principal, so the old identity is not kept.
    expect: () => undefined,
    bumps: true
  },
  {
    name: "SignedIn (another profile)",
    event: IdentityEvent.SignedIn({ profile: other, identity: newIdentity }),
    expect: () => "same",
    bumps: true
  },
  {
    name: "SignedOut",
    event: IdentityEvent.SignedOut(),
    expect: (from) => from === "Absent" ? undefined : stateOf.SignedOut,
    bumps: true
  }
]

const stateNames: ReadonlyArray<StateName> = ["Absent", "Resolved", "LookupFailed", "AuthFailed", "SignedOut"]

/** The invariants every transition keeps, checked through the projection onto AppState. */
const expectInvariants = (lifecycle: IdentityLifecycle) => {
  for (const profile of Object.keys(lifecycle.profiles)) expect(lifecycle.enabled).toContain(profile)
  const app = applyIdentityEvent(
    { pullRequests: [], accounts: [], status: "idle", identityLifecycle: lifecycle },
    // A stale ResolutionFinished changes nothing, so this only projects.
    IdentityEvent.ResolutionFinished({ generation: -1 })
  )
  const ownerState = lifecycle.enabled[0] === undefined ? undefined : lifecycle.profiles[lifecycle.enabled[0]]
  expect(app.currentUser).toBe(ownerState?._tag === "Resolved" ? ownerState.username : undefined)
}

describe("identity lifecycle table", () => {
  for (const from of stateNames) {
    for (const column of columns) {
      it(`${from} + ${column.name}`, () => {
        const before = lifecycleWith(stateOf[from])
        const after = transition(before, column.event)
        const expected = column.expect(from)
        expect(after.profiles[subject]).toEqual(expected === "same" ? stateOf[from] : expected)
        expect(after.generation).toBe(column.bumps ? generation + 1 : generation)
        expectInvariants(after)
      })
    }
  }

  const stamped = columns.filter((column) => "generation" in column.event)
  for (const from of stateNames) {
    for (const column of stamped) {
      it(`${from} + stale ${column.name} does nothing`, () => {
        const before = lifecycleWith(stateOf[from])
        expect(transition({ ...before, generation: generation + 1 }, column.event)).toEqual({
          ...before,
          generation: generation + 1
        })
      })
    }
  }

  it("ignores a stamped event for a profile that is not enabled", () => {
    const before = lifecycleWith(undefined)
    for (
      const event of [
        IdentityEvent.LookupSucceeded({ generation, profile: "disabled", identity: newIdentity }),
        IdentityEvent.LookupFailed({ generation, profile: "disabled", reason: { _tag: "Throttled" } }),
        IdentityEvent.RefreshAuthFailed({ generation, profile: "disabled" })
      ]
    ) expect(transition(before, event)).toEqual(before)
  })

  it("ResolutionFinished is the only event that marks the first refresh done", () => {
    for (const column of columns) {
      expect(transition(lifecycleWith(undefined), column.event).firstRefreshDone)
        .toBe(column.name === "ResolutionFinished")
    }
  })

  it("follows the owner for currentUser: signing in to another account does not replace it", () => {
    const signedIn = applyIdentityEvent(
      { pullRequests: [], accounts: [], status: "idle", identityLifecycle: lifecycleWith(undefined) },
      IdentityEvent.SignedIn({ profile: other, identity: newIdentity })
    )
    expect(signedIn.currentUser).toBe("old")
  })

  it("lets the newest of two overlapping refreshes win, so a toggled-off account stays absent", () => {
    const empty: AppState = { pullRequests: [], accounts: [], status: "idle" }
    // Pass A starts with both accounts; the user switches "subject" off; pass B starts.
    const passA = applyIdentityEvent(empty, IdentityEvent.RefreshStarted({ enabled: [owner, subject] }))
    const generationA = passA.identityLifecycle?.generation ?? -1
    const passB = applyIdentityEvent(passA, IdentityEvent.RefreshStarted({ enabled: [owner] }))
    // Pass A's lookups land late.
    const late = [owner, subject].reduce(
      (state, profile) =>
        applyIdentityEvent(
          state,
          IdentityEvent.LookupSucceeded({ generation: generationA, profile, identity: oldIdentity })
        ),
      passB
    )
    expect(late.callerIdentities).toBeUndefined()
    expect(late.currentUser).toBeUndefined()
  })
})
