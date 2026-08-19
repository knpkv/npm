import { describe, expect, it } from "@effect/vitest"
import { assumeConsoleArgs, codecommitConsoleHost, codecommitFileConsoleUrl } from "../src/tui/browser-command.js"

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

  it("selects the console domain from the region's AWS partition", () => {
    // The console lives on a different domain per partition, so a commercial-only
    // hostname would send a China or GovCloud account to a domain it cannot reach.
    const cases: ReadonlyArray<readonly [string, string | null]> = [
      ["eu-west-1", "console.aws.amazon.com"],
      ["us-east-1", "console.aws.amazon.com"],
      ["cn-north-1", "console.amazonaws.cn"],
      ["cn-northwest-1", "console.amazonaws.cn"],
      // Tested before the commercial pattern, which `us-gov-…` also matches.
      ["us-gov-west-1", "console.amazonaws-us-gov.com"],
      // Isolated partitions are declined rather than guessed at.
      ["us-iso-east-1", null],
      ["us-isob-east-1", null],
      ["eu-isoe-west-1", null],
      ["eusc-de-east-1", null],
      ["not-a-region", null]
    ]

    for (const [region, host] of cases) {
      expect(codecommitConsoleHost(region)).toBe(host)
    }
  })

  it("builds a partition-correct link and declines an unsupported one", () => {
    const target = { commitId: "3f7a1c9", filePath: "src/a.ts", repositoryName: "payments-api" }

    expect(codecommitFileConsoleUrl({ ...target, region: "cn-north-1" })).toBe(
      "https://cn-north-1.console.amazonaws.cn/codesuite/codecommit/repositories/payments-api/browse/3f7a1c9/--/src/a.ts?region=cn-north-1"
    )
    expect(codecommitFileConsoleUrl({ ...target, region: "us-gov-west-1" })).toBe(
      "https://us-gov-west-1.console.amazonaws-us-gov.com/codesuite/codecommit/repositories/payments-api/browse/3f7a1c9/--/src/a.ts?region=us-gov-west-1"
    )
    // Null rather than a plausible-looking wrong URL: nothing reaches `assume`.
    expect(codecommitFileConsoleUrl({ ...target, region: "us-iso-east-1" })).toBeNull()
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
