import { assert, describe, it } from "@effect/vitest"

import { discoveryFailureMessage } from "../../src/client/services/AwsAccountSetupForm.js"

describe("AWS discovery failure copy", () => {
  it("names the shadowing credentials section and how to remove it", () => {
    const message = discoveryFailureMessage("CodePipeline", "dev-administratoraccess", {
      _tag: "failed",
      failureClass: "authentication",
      cause: "static-keys-shadow-sso"
    })
    assert.include(message, "~/.aws/credentials")
    assert.include(message, "[dev-administratoraccess]")
  })

  it("points an expired sign-in at aws sso login for the same profile", () => {
    const message = discoveryFailureMessage("CodeCommit", "dev", { _tag: "failed", failureClass: "authentication" })
    assert.include(message, "aws sso login --profile dev")
  })

  it("never prints the raw failure class", () => {
    const failureClasses: ReadonlyArray<Parameters<typeof discoveryFailureMessage>[2]["failureClass"]> = [
      "authentication",
      "authorization",
      "malformed-response",
      "rate-limit",
      "timeout",
      "unavailable"
    ]
    for (const failureClass of failureClasses) {
      const message = discoveryFailureMessage("CodePipeline", "dev", { _tag: "failed", failureClass })
      assert.notInclude(message, `(${failureClass})`)
    }
  })
})
