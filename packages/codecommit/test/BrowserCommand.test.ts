import { describe, expect, it } from "@effect/vitest"
import { assumeConsoleArgs, codecommitFileConsoleUrl } from "../src/tui/browser-command.js"

describe("Granted browser command", () => {
  it("uses the long console-destination alias without colliding with duration", () => {
    expect(assumeConsoleArgs("https://console.aws.amazon.com/codecommit/pr/44", "dev-admin")).toEqual([
      "--cd",
      "https://console.aws.amazon.com/codecommit/pr/44",
      "dev-admin"
    ])
  })
})

describe("CodeCommit file console url", () => {
  it("pins the reviewed commit so the opened page cannot drift to a newer head", () => {
    expect(
      codecommitFileConsoleUrl({
        commitId: "3f7a1c9",
        filePath: "packages/codecommit/src/tui/browser-command.ts",
        region: "eu-west-1",
        repositoryName: "payments-api"
      })
    ).toBe(
      "https://eu-west-1.console.aws.amazon.com/codesuite/codecommit/repositories/payments-api/browse/3f7a1c9/--/packages/codecommit/src/tui/browser-command.ts?region=eu-west-1"
    )
  })

  it("encodes each path segment while keeping the separators the console parses", () => {
    expect(
      codecommitFileConsoleUrl({
        commitId: "3f7a1c9",
        filePath: "/src/a b/report?draft.md",
        region: "eu-west-1",
        repositoryName: "payments api"
      })
    ).toBe(
      "https://eu-west-1.console.aws.amazon.com/codesuite/codecommit/repositories/payments%20api/browse/3f7a1c9/--/src/a%20b/report%3Fdraft.md?region=eu-west-1"
    )
  })
})
