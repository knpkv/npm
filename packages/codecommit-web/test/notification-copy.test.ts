import { describe, expect, it } from "@effect/vitest"
import { failedOperationText, fixFor } from "../src/client/notification-copy.js"

describe("failed operation copy", () => {
  it("says what failed where, the provider's cause, and the fix", () => {
    expect(
      failedOperationText({
        cause: "UnrecognizedClientException: The security token included in the request is invalid.",
        operation: "getPullRequests",
        profile: "dev-administratoraccess",
        region: "eu-central-1"
      })
    ).toBe(
      "Couldn't list pull requests in dev-administratoraccess (eu-central-1): UnrecognizedClientException: The security token included in the request is invalid. Sign in again in Settings → Accounts."
    )
  })

  it("picks the one fix by cause, or none", () => {
    expect(fixFor("Throttled: Rate exceeded")).toBe("It's retried on the next refresh.")
    expect(fixFor("AccessDeniedException: not authorized to perform codecommit:ListPullRequests")).toBe(
      "Check that this profile's role can read CodeCommit."
    )
    expect(fixFor("RepositoryDoesNotExistException: gone")).toBeNull()
  })

  it("still reads as a sentence for older rows without a cause or profile", () => {
    expect(failedOperationText({ operation: "listBranches" })).toBe("listBranches failed.")
  })
})
