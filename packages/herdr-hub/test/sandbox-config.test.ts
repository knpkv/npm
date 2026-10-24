import type { Credentials } from "@distilled.cloud/aws"
import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { PoolContract, type PoolSession } from "@knpkv/sandbox-pool"
import { Effect, Redacted, Schema } from "effect"
import * as FileSystem from "effect/FileSystem"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Path from "effect/Path"
import type { AwsSignIn } from "../src/aws-sign-in.js"
import { AwsSignInRequired, AwsSignInUnavailable } from "../src/aws-sign-in.js"
import {
  cleaningUnderSignIn,
  formatResetInspection,
  makeSandboxPoolFromConfig,
  sandboxPoolAdapters,
  SandboxPoolSettings,
  sandboxResetCheck
} from "../src/sandbox-config.js"

/** An invented pool: no real organization's IDs or names. */
const contractInput = {
  accounts: [
    { name: "sandbox-a", accountId: "999999999990" },
    { name: "sandbox-b", accountId: "999999999991" }
  ],
  nukeBlocklist: ["999999999900"],
  regions: ["eu-central-1"],
  accountAccessRole: "PoolAccessRole",
  boundaryPath: "/pool/",
  boundaryName: "PoolBoundary",
  accountAliasPrefix: "example-pool-",
  budgetActionRole: "example-pool-budget-action",
  denyAllPolicy: "PoolDenyAll"
}
const contract = Schema.decodeUnknownSync(PoolContract)(contractInput)
const operator = {
  startUrl: "https://example.awsapps.com/start",
  ssoRegion: "eu-central-1",
  accountId: "999999999900",
  roleName: "PoolOperator",
  region: "us-east-1"
}
const boundaryPolicy = { Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: "x:*", Resource: "*" }] }
const settings = (mode: string) => Schema.decodeUnknownSync(SandboxPoolSettings)({ mode, operator, boundaryPolicy })
const session: PoolSession = {
  accessKeyId: "ASIAPOOL",
  secretAccessKey: Redacted.make("pool-secret"),
  sessionToken: Redacted.make("pool-token")
}
const credentials: Credentials.Credentials["Service"] = Effect.succeed({
  accessKeyId: Redacted.make("test"),
  secretAccessKey: Redacted.make("test"),
  sessionToken: undefined,
  region: "us-east-1"
})

/** An AWS that refuses every call and records which service each went to. */
const refusingAws = (hosts: Array<string>) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      hosts.push(new URL(request.url).host)
      return HttpClientResponse.fromWeb(
        request,
        new Response("<ErrorResponse><Error><Code>AccessDenied</Code><Message>no</Message></Error></ErrorResponse>", {
          status: 403,
          headers: { "content-type": "text/xml" }
        })
      )
    })
  )

it.layer(NodeServices.layer)("sandbox pool modes", (it) => {
  it.effect("off builds nothing; observe reads spend and refuses every write; live wires every adapter", () =>
    Effect.gen(function*() {
      const hosts: Array<string> = []
      const dependencies = {
        credentials,
        http: refusingAws(hosts),
        nuke: { binary: "/opt/aws-nuke", configDirectory: "/state/aws-nuke" }
      }
      expect(yield* sandboxPoolAdapters("off", contract, settings("off"), dependencies)).toBeNull()

      const observe = yield* sandboxPoolAdapters("observe", contract, settings("observe"), dependencies)
      expect(observe?.registersJobs).toBe(false)
      expect(observe?.spend).toBeDefined()
      const refusals = observe === null ? [] : yield* Effect.all([
        Effect.flip(observe.access.session("999999999990")),
        Effect.flip(observe.access.ensureBaseline("999999999990", session)),
        Effect.flip(observe.access.budgetHold("999999999990", session)),
        Effect.flip(observe.nuke.writeConfig("999999999990", "{}")),
        Effect.flip(observe.nuke.run({ configPath: "/state/aws-nuke/x.json", session, live: true }))
      ])
      expect(refusals.map(({ step }) => step)).toEqual(["disabled", "disabled", "disabled", "disabled", "disabled"])
      const lift = observe === null ? null : yield* Effect.flip(observe.budget.lift("999999999990"))
      expect(lift?._tag).toBe("BudgetLiftFailed")
      // Observe never reaches AWS for a write: nothing above made a call.
      expect(hosts).toEqual([])

      const live = yield* sandboxPoolAdapters("live", contract, settings("live"), dependencies)
      expect(live?.registersJobs).toBe(true)
      const signIn = live === null ? null : yield* Effect.flip(live.access.session("999999999990"))
      expect(signIn?.step).toBe("sign in")
      expect(hosts).toEqual(["sts.us-east-1.amazonaws.com"])
    }))

  it.effect("live needs the boundary policy and an aws-nuke binary", () =>
    Effect.gen(function*() {
      const dependencies = { credentials, http: refusingAws([]), nuke: undefined }
      const noBinary = yield* Effect.flip(sandboxPoolAdapters("live", contract, settings("live"), dependencies))
      expect(noBinary).toMatchObject({ _tag: "SandboxPoolConfigInvalid", detail: "live mode needs an aws-nuke binary" })
      const noBoundary = yield* Effect.flip(
        sandboxPoolAdapters(
          "live",
          contract,
          Schema.decodeUnknownSync(SandboxPoolSettings)({ mode: "live", operator }),
          { ...dependencies, nuke: { binary: "/opt/aws-nuke", configDirectory: "/state/aws-nuke" } }
        )
      )
      expect(noBoundary).toMatchObject({
        _tag: "SandboxPoolConfigInvalid",
        detail: "live mode needs sandboxPool.boundaryPolicy"
      })
    }))

  it.effect("an absent or off pool opens nothing; observe opens the pool store; a bad mode or no operator fails", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const stateDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "sandbox-config-" })
      const from = (sandboxPool: { readonly [key: string]: Schema.Json } | undefined) =>
        makeSandboxPoolFromConfig({
          sandboxPool,
          stateDirectory,
          nukeBinary: undefined,
          onPending: () => Effect.void
        }).pipe(Effect.provideService(HttpClient.HttpClient, refusingAws([])))
      expect(yield* from(undefined)).toBeNull()
      expect(yield* from(contractInput)).toBeNull()
      expect(yield* from({ ...contractInput, mode: "off", operator })).toBeNull()
      expect(yield* fs.readDirectory(stateDirectory)).toEqual([])

      const observed = yield* from({ ...contractInput, mode: "observe", operator })
      expect([observed?.mode, observed?.registersJobs]).toEqual(["observe", false])
      expect(yield* fs.exists(path.join(stateDirectory, "sandboxes.sqlite"))).toBe(true)

      const badMode = yield* Effect.flip(from({ ...contractInput, mode: "nuke", operator }))
      expect(badMode._tag).toBe("SandboxPoolConfigInvalid")
      const noOperator = yield* Effect.flip(from({ ...contractInput, mode: "observe" }))
      expect(noOperator).toMatchObject({
        _tag: "SandboxPoolConfigInvalid",
        detail: "observe mode needs sandboxPool.operator"
      })
    }).pipe(Effect.scoped))

  it.effect("the reset check needs the hub's AWS sign-in and starts none, calling nothing without it", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const stateDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "sandbox-check-" })
      const hosts: Array<string> = []
      const failure = yield* sandboxResetCheck({
        sandboxPool: { ...contractInput, operator, boundaryPolicy },
        stateDirectory,
        nukeBinary: "/opt/aws-nuke",
        accountId: "999999999990"
      }).pipe(Effect.provideService(HttpClient.HttpClient, refusingAws(hosts)), Effect.flip)
      expect(failure).toMatchObject({ _tag: "AwsSignInRequired", pending: false })
      expect(hosts).toEqual([])
      expect(yield* fs.exists(path.join(stateDirectory, "aws-sign-in-check-pending.json"))).toBe(false)
    }).pipe(Effect.scoped))
})

it("the hub's read side still decodes a sandboxPool that carries the mode, operator and boundary", () => {
  expect(
    Schema.decodeUnknownSync(PoolContract)({ ...contractInput, mode: "observe", operator, boundaryPolicy }).accounts
  ).toEqual(contract.accounts)
})

it("prints a reset inspection as the plan, the dry run and the budget hold", () => {
  expect(formatResetInspection({
    accountId: "999999999990",
    baseline: [{ _tag: "CreateAlias", alias: "example-pool-sandbox-a" }, {
      _tag: "UpdateBoundary",
      deleteVersion: "v1"
    }],
    dryRun: {
      exitCode: 0,
      removable: 2,
      wouldRemove: [
        "eu-central-1 - EC2Instance - i-0abc - would remove",
        "global - IAMRole - PoolAccessRole - would remove"
      ],
      protectedListed: [{
        protectedClass: "organization access role",
        line: "global - IAMRole - PoolAccessRole - would remove"
      }],
      discoveryFailures: []
    },
    budgetHeld: false
  })).toBe(
    [
      "account 999999999990",
      "baseline: would create alias example-pool-sandbox-a; would replace the boundary, dropping version v1",
      "budget hold: not attached",
      "aws-nuke dry run: exit 0, 2 removable",
      "  eu-central-1 - EC2Instance - i-0abc - would remove",
      "  global - IAMRole - PoolAccessRole - would remove",
      "protected in the removal list (a reset stops before its live run):",
      "  organization access role: global - IAMRole - PoolAccessRole - would remove",
      "incomplete discovery: none"
    ].join("\n")
  )
})

/**
 * A sign-in whose stored state reads as signed in, whose `accessToken` answers `token`, and which records when its
 * hold is taken and released around what runs inside it.
 */
const holdingSignIn = (
  token: Effect.Effect<Redacted.Redacted<string>, AwsSignInRequired | AwsSignInUnavailable>,
  held: Array<string>
): AwsSignIn => ({
  state: Effect.succeed({ _tag: "SignedIn", expiresAt: 1 }),
  accessToken: token,
  begin: Effect.die("no sign-in expected"),
  signOut: Effect.die("no sign-out expected"),
  hold: (effect) =>
    Effect.sync(() => held.push("take")).pipe(
      Effect.andThen(effect),
      Effect.ensuring(Effect.sync(() => held.push("release")))
    ),
  revoked: () => Effect.void,
  region: "eu-central-1"
})

// The pool's moves into Cleaning run through this: inside the sign-in's hold, and only with a usable access token.
// The stored state isn't enough: it reads as signed in for an expired token whose refresh AWS then refuses.
it.effect("a move into Cleaning runs inside the sign-in's hold only with a usable token; none, or an unreadable one, refuses", () =>
  Effect.gen(function*() {
    const held: Array<string> = []
    const signedIn = cleaningUnderSignIn(holdingSignIn(Effect.succeed(Redacted.make("token")), held))
    expect(yield* signedIn(Effect.sync(() => held.push("write")).pipe(Effect.as("moved")))).toBe("moved")
    expect(held).toEqual(["take", "write", "release"])
    const refusing: ReadonlyArray<Effect.Effect<Redacted.Redacted<string>, AwsSignInRequired | AwsSignInUnavailable>> =
      [
        Effect.fail(new AwsSignInRequired({ pending: false })),
        Effect.fail(new AwsSignInRequired({ pending: true })),
        Effect.fail(new AwsSignInUnavailable({ operation: "refresh", detail: "unreachable" }))
      ]
    for (const token of refusing) {
      const seen: Array<string> = []
      const failure = yield* Effect.flip(
        cleaningUnderSignIn(holdingSignIn(token, seen))(Effect.sync(() => seen.push("write")))
      )
      expect([failure._tag, seen]).toEqual(["ResetNeedsSignIn", ["take", "release"]])
    }
  }))
