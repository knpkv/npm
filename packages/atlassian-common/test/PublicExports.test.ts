import { JIRA_PROPOSAL_SCOPES, JIRA_SCOPES } from "../src/auth/index.js"
import { JIRA_PROPOSAL_REQUIRED_SCOPES, JIRA_REQUIRED_SCOPES } from "../src/config/index.js"

describe("public compatibility exports", () => {
  it("retains proposal-only Jira scopes beside the write-capable release scopes", () => {
    expect(JIRA_PROPOSAL_SCOPES).toEqual([
      "read:jira-work",
      "read:jira-user",
      "read:me",
      "offline_access"
    ])
    expect(JIRA_PROPOSAL_REQUIRED_SCOPES).toEqual(JIRA_PROPOSAL_SCOPES)
    expect(JIRA_SCOPES).toContain("manage:jira-configuration")
    expect(JIRA_REQUIRED_SCOPES).toContain("manage:jira-project")
  })
})
