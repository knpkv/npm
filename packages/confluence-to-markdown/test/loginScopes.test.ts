import { describe, expect, it } from "@effect/vitest"
import { CONFLUENCE_FOLDER_SCOPES, CONFLUENCE_SCOPES } from "@knpkv/atlassian-common/auth"
import { CLI_LOGIN_SCOPES } from "../src/ConfluenceAuth.js"

describe("CLI_LOGIN_SCOPES", () => {
  // The folder/search commands are unusable without these, and the failure is a
  // 401 at call time rather than anything the type system sees.
  it("requests both the shared page set and the folder/search scopes", () => {
    for (const scope of [...CONFLUENCE_SCOPES, ...CONFLUENCE_FOLDER_SCOPES]) {
      expect(CLI_LOGIN_SCOPES).toContain(scope)
    }
  })

  // Atlassian rejects the whole authorize request over a malformed scope list,
  // so a duplicate from a careless union would break login outright.
  it("lists every scope exactly once", () => {
    expect(new Set(CLI_LOGIN_SCOPES).size).toBe(CLI_LOGIN_SCOPES.length)
  })
})
