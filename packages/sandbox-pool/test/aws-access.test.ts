import { Credentials } from "@distilled.cloud/aws"
import { describe, expect, it, layer } from "@effect/vitest"
import { Effect, Redacted, Result } from "effect"
import { makeStsPoolAccess, type ObservedBaseline, planBaseline } from "../src/aws.js"
import type { PoolSession } from "../src/index.js"
import { against, type FakeAnswer, fakeAws, json, type SeenCall, xml } from "./fake-aws.js"
import { contract } from "./fixtures.js"

const boundary = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Effect: "Deny", Action: "x:*", Resource: "*" }]
})
const options = { contract, boundaryDocument: boundary }
const session: PoolSession = {
  accessKeyId: "ASIAPOOLSESSION",
  secretAccessKey: Redacted.make("pool-secret"),
  sessionToken: Redacted.make("pool-token")
}

const result = (operation: string, fields: string): FakeAnswer =>
  xml(`<${operation}Response><${operation}Result>${fields}</${operation}Result></${operation}Response>`)
const iamError = (code: string, status = 400): FakeAnswer =>
  xml(
    `<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>says no</Message></Error></ErrorResponse>`,
    status
  )
const aliases = (...names: ReadonlyArray<string>) =>
  result(
    "ListAccountAliases",
    `<AccountAliases>${
      names.map((name) => `<member>${name}</member>`).join("")
    }</AccountAliases><IsTruncated>false</IsTruncated>`
  )
const versions = (count: number) =>
  result(
    "ListPolicyVersions",
    `<Versions>${
      Array.from({ length: count }, (_, index) =>
        `<member><VersionId>v${index + 1}</VersionId><IsDefaultVersion>${
          index === count - 1
        }</IsDefaultVersion><CreateDate>2026-0${index + 1}-01T00:00:00Z</CreateDate></member>`).join("")
    }</Versions><IsTruncated>false</IsTruncated>`
  )

/** A pool account's IAM: its aliases, its boundary document (absent: none) and how many versions it has. */
const account =
  (state: { aliases: ReadonlyArray<string>; boundary?: string; versions?: number }) => (call: SeenCall): FakeAnswer => {
    switch (call.operation) {
      case "ListAccountAliases":
        return aliases(...state.aliases)
      case "GetPolicy":
        return state.boundary === undefined
          ? iamError("NoSuchEntity", 404)
          : result(
            "GetPolicy",
            `<Policy><PolicyName>PoolBoundary</PolicyName><DefaultVersionId>v${
              state.versions ?? 1
            }</DefaultVersionId></Policy>`
          )
      case "GetPolicyVersion":
        return result(
          "GetPolicyVersion",
          `<PolicyVersion><Document>${
            encodeURIComponent(state.boundary ?? "")
          }</Document><IsDefaultVersion>true</IsDefaultVersion></PolicyVersion>`
        )
      case "ListPolicyVersions":
        return versions(state.versions ?? 1)
      default:
        return result(call.operation, "")
    }
  }

const access = makeStsPoolAccess(options)
const writes = (seen: ReadonlyArray<SeenCall>) =>
  seen.filter(({ operation }) => !/^(List|Get)/.test(operation)).map(({ body, operation }) => {
    const { Action: _action, Version: _version, ...rest } = body
    return [operation, rest]
  })

layer(Credentials.mock)("STS pool access", (it) => {
  it.effect("assumes the contract's access role in the account for one hour, with the management credentials", () => {
    const seen: Array<SeenCall> = []
    const assumed = result(
      "AssumeRole",
      "<Credentials><AccessKeyId>ASIANEW</AccessKeyId><SecretAccessKey>new-secret</SecretAccessKey><SessionToken>new-token</SessionToken><Expiration>2026-10-23T12:00:00Z</Expiration></Credentials>"
    )
    return access.pipe(
      Effect.flatMap((pool) => pool.session("222222222222")),
      Effect.map((assumedSession) => {
        expect([
          assumedSession.accessKeyId,
          Redacted.value(assumedSession.secretAccessKey),
          Redacted.value(assumedSession.sessionToken)
        ]).toEqual(["ASIANEW", "new-secret", "new-token"])
        expect(seen.map(({ body }) => [body["Action"], body["RoleArn"], body["DurationSeconds"]])).toEqual([
          ["AssumeRole", "arn:aws:iam::222222222222:role/PoolAccessRole", "3600"]
        ])
        expect(seen[0]?.authorization).toContain("Credential=test/")
      }),
      against(fakeAws(() => assumed, seen))
    )
  })

  it.effect("every method refuses an account outside the pool without calling AWS", () =>
    Effect.gen(function*() {
      const seen: Array<SeenCall> = []
      const pool = yield* access.pipe(against(fakeAws(() => result("AssumeRole", ""), seen)))
      const refusals = yield* Effect.forEach([
        pool.session("999999999999"),
        pool.ensureBaseline("999999999999", session),
        pool.budgetHold("999999999999", session)
      ], (call) => call.pipe(Effect.flip, against(fakeAws(() => result("AssumeRole", ""), seen))))
      expect(refusals.map(({ detail, step }) => [step, detail])).toEqual([
        ["sign in", "not a pool account"],
        ["baseline", "not a pool account"],
        ["budget hold check", "not a pool account"]
      ])
      expect(seen).toEqual([])
    }))

  it.effect("names a refused assume-role", () =>
    Effect.gen(function*() {
      const refused = yield* access.pipe(
        Effect.flatMap((pool) => pool.session("222222222222")),
        Effect.flip,
        against(fakeAws(() => iamError("AccessDenied", 403)))
      )
      expect(refused.step).toBe("sign in")
      expect(refused.detail).toContain("says no")
    }))

  it.effect("writes the alias and the boundary into a fresh account with the account's own session", () => {
    const seen: Array<SeenCall> = []
    return access.pipe(
      Effect.flatMap((pool) => pool.ensureBaseline("222222222222", session)),
      Effect.map(() => {
        expect(writes(seen)).toEqual([
          ["CreateAccountAlias", { AccountAlias: "example-pool-sandbox-b" }],
          ["CreatePolicy", {
            PolicyName: "PoolBoundary",
            Path: "/pool/",
            PolicyDocument: boundary,
            Description: "Permissions boundary for pool workloads"
          }]
        ])
        expect(seen.every(({ authorization }) => authorization.includes("Credential=ASIAPOOLSESSION/"))).toBe(true)
      }),
      against(fakeAws(account({ aliases: [] }), seen))
    )
  })

  it.effect("writes nothing when the alias and boundary are in place, whatever the document's spacing", () => {
    const seen: Array<SeenCall> = []
    const spaced = JSON.stringify(JSON.parse(boundary), null, 2)
    return access.pipe(
      Effect.flatMap((pool) => pool.ensureBaseline("222222222222", session)),
      Effect.map(() => expect(writes(seen)).toEqual([])),
      against(fakeAws(account({ aliases: ["example-pool-sandbox-b"], boundary: spaced }), seen))
    )
  })

  it.effect("reads a stored document with a literal % and reordered keys as in place", () => {
    const seen: Array<SeenCall> = []
    const withPercent = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Deny",
        Action: "x:*",
        Resource: "*",
        Condition: { StringLike: { "aws:userid": "100%*" } }
      }]
    })
    const reordered = JSON.stringify({
      Statement: [{
        Resource: "*",
        Condition: { StringLike: { "aws:userid": "100%*" } },
        Action: "x:*",
        Effect: "Deny"
      }],
      Version: "2012-10-17"
    })
    return makeStsPoolAccess({ contract, boundaryDocument: withPercent }).pipe(
      Effect.flatMap((pool) => pool.ensureBaseline("222222222222", session)),
      Effect.map(() => expect(writes(seen)).toEqual([])),
      against(fakeAws(account({ aliases: ["example-pool-sandbox-b"], boundary: reordered }), seen))
    )
  })

  it.effect("blocks, writing nothing, on a document that is not URL-encoded JSON or a version without id or date", () =>
    Effect.gen(function*() {
      const failure = (answer: (call: SeenCall) => FakeAnswer) => {
        const seen: Array<SeenCall> = []
        return access.pipe(
          Effect.flatMap((pool) => pool.ensureBaseline("222222222222", session)),
          Effect.flip,
          Effect.map((blocked) => ({ blocked, writes: writes(seen) })),
          against(fakeAws(answer, seen))
        )
      }
      const base = account({ aliases: ["example-pool-sandbox-b"], boundary: "{}", versions: 2 })
      const undecodable = yield* failure((call) =>
        call.operation === "GetPolicyVersion"
          ? result("GetPolicyVersion", "<PolicyVersion><Document>%E0%A4%A</Document></PolicyVersion>")
          : base(call)
      )
      const noDefault = yield* failure((call) =>
        call.operation === "GetPolicy"
          ? result("GetPolicy", "<Policy><PolicyName>PoolBoundary</PolicyName></Policy>")
          : base(call)
      )
      const undated = yield* failure((call) =>
        call.operation === "ListPolicyVersions"
          ? result(
            "ListPolicyVersions",
            "<Versions><member><VersionId>v1</VersionId><IsDefaultVersion>true</IsDefaultVersion></member></Versions>"
          )
          : base(call)
      )
      expect([undecodable, noDefault, undated].map(({ blocked, writes }) => [blocked.step, blocked.detail, writes]))
        .toEqual([
          ["baseline", "boundary policy is not JSON", []],
          ["baseline", "boundary policy without a default version", []],
          ["baseline", "policy version without id or date", []]
        ])
    }))

  it.effect("replaces a drifted boundary as the new default, dropping the oldest version at five", () => {
    const seen: Array<SeenCall> = []
    const arn = "arn:aws:iam::222222222222:policy/pool/PoolBoundary"
    return access.pipe(
      Effect.flatMap((pool) => pool.ensureBaseline("222222222222", session)),
      Effect.map(() =>
        expect(writes(seen)).toEqual([
          ["DeletePolicyVersion", { PolicyArn: arn, VersionId: "v1" }],
          ["CreatePolicyVersion", { PolicyArn: arn, PolicyDocument: boundary, SetAsDefault: "true" }]
        ])
      ),
      against(fakeAws(account({ aliases: ["example-pool-sandbox-b"], boundary: "{}", versions: 5 }), seen))
    )
  })

  it.effect("blocks on a foreign alias and on a refused write, writing nothing more", () =>
    Effect.gen(function*() {
      const foreign: Array<SeenCall> = []
      const alias = yield* access.pipe(
        Effect.flatMap((pool) => pool.ensureBaseline("222222222222", session)),
        Effect.flip,
        against(fakeAws(account({ aliases: ["someone-else"] }), foreign))
      )
      expect([alias.step, alias.detail, writes(foreign)]).toEqual([
        "baseline",
        "unexpected account alias someone-else",
        []
      ])
      const refused = yield* access.pipe(
        Effect.flatMap((pool) => pool.ensureBaseline("222222222222", session)),
        Effect.flip,
        against(
          fakeAws((call) =>
            call.operation === "CreateAccountAlias" ? iamError("AccessDenied", 403) : account({ aliases: [] })(call)
          )
        )
      )
      expect(refused.step).toBe("baseline")
      expect(refused.detail).toContain("says no")
    }))

  it.effect("reads the budget hold in the management account: held only while the deny-all policy is attached", () =>
    Effect.gen(function*() {
      const hold = (...names: ReadonlyArray<string>) => {
        const seen: Array<SeenCall> = []
        return access.pipe(
          Effect.flatMap((pool) => pool.budgetHold("222222222222", session)),
          Effect.map((held) => ({ held, seen })),
          against(fakeAws(() => json({ Policies: names.map((Name, index) => ({ Id: `p-${index}`, Name })) }), seen))
        )
      }
      const held = yield* hold("FullAWSAccess", "PoolDenyAll")
      expect(held.held).toBe(true)
      expect(
        held.seen.map((
          { authorization, body, operation }
        ) => [operation, body["TargetId"], authorization.includes("Credential=test/")])
      )
        .toEqual([["ListPoliciesForTarget", "222222222222", true]])
      expect((yield* hold("FullAWSAccess")).held).toBe(false)
    }))
})

describe("planBaseline", () => {
  const plan = (observed: ObservedBaseline) =>
    Effect.runSync(Effect.result(planBaseline(observed, "example-pool-sandbox-b", boundary)))
  const history = (count: number) =>
    Array.from(
      { length: count },
      (_, index) => ({ versionId: `v${count - index}`, isDefault: index === 0, createdAt: count - index })
    )

  it("drops the oldest non-default version by date, whatever order IAM lists them in", () => {
    for (const listed of [history(5), history(5).reverse()]) {
      const result = plan({ aliases: ["example-pool-sandbox-b"], boundary: { document: "{}", versions: listed } })
      expect(Result.getOrThrow(result)).toEqual([{ _tag: "UpdateBoundary", deleteVersion: "v1" }])
    }
    const room = plan({ aliases: ["example-pool-sandbox-b"], boundary: { document: "{}", versions: history(2) } })
    expect(Result.getOrThrow(room)).toEqual([{ _tag: "UpdateBoundary", deleteVersion: undefined }])
  })
})
