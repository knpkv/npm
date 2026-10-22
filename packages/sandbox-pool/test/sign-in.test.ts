import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { cliProfile, consoleUrl, SandboxSignIn, signInOf } from "../src/host.js"
import { AccountId, PoolContract, SandboxName } from "../src/index.js"
import { contractInput } from "./fixtures.js"

const access = {
  portalUrl: "https://portal.example.test/start",
  ssoSession: "example-session",
  roleName: "ExampleDeveloper"
}
const account = Schema.decodeUnknownSync(AccountId)("222222222222")
const name = Schema.decodeUnknownSync(SandboxName)("sandbox-b")

describe("pool sign-in", () => {
  it("keeps sign-in optional, and refuses a portal that is not plain https or names that break a profile", () => {
    const decode = Schema.decodeUnknownResult(PoolContract)
    expect(decode(contractInput)._tag).toBe("Success")
    expect(decode({ ...contractInput, access })._tag).toBe("Success")
    for (
      const portalUrl of [
        "http://portal.example.test/start",
        "https://portal.example.test/start?next=1",
        "https://portal.example.test/start#/console",
        "javascript:alert(1)",
        "https://portal example.test/start"
      ]
    ) {
      expect(decode({ ...contractInput, access: { ...access, portalUrl } })._tag).toBe("Failure")
    }
    expect(decode({ ...contractInput, access: { ...access, ssoSession: "a\nregion = x" } })._tag).toBe("Failure")
    expect(decode({ ...contractInput, access: { ...access, roleName: "Role Name" } })._tag).toBe("Failure")
  })

  it("serves sign-in with the pool's first region, and none without access", () => {
    const pool = Schema.decodeUnknownSync(PoolContract)({ ...contractInput, access })
    expect(signInOf(pool)).toEqual({ ...access, region: "eu-central-1" })
    expect(signInOf(Schema.decodeUnknownSync(PoolContract)(contractInput))).toBeNull()
  })

  it("links the portal's console for one account and role, and writes its CLI profile", () => {
    const signIn = Schema.decodeUnknownSync(SandboxSignIn)({ ...access, region: "eu-central-1" })
    expect(consoleUrl(signIn, account)).toBe(
      "https://portal.example.test/start/#/console?account_id=222222222222&role_name=ExampleDeveloper"
    )
    expect(consoleUrl({ ...signIn, portalUrl: "https://portal.example.test/start/" }, account)).toBe(
      "https://portal.example.test/start/#/console?account_id=222222222222&role_name=ExampleDeveloper"
    )
    expect(cliProfile(signIn, name, account)).toBe(
      [
        "[profile sandbox-b]",
        "sso_session = example-session",
        "sso_account_id = 222222222222",
        "sso_role_name = ExampleDeveloper",
        "region = eu-central-1"
      ].join("\n")
    )
  })
})
