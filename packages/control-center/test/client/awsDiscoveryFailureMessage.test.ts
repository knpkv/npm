import { assert, describe, it } from "@effect/vitest"

import { discoveryFailureMessage } from "../../src/client/services/AwsAccountSetupForm.js"

describe("AWS discovery failure copy", () => {
  it("does not prescribe SSO or deleting static keys without credential-source evidence", () => {
    const message = discoveryFailureMessage("CodePipeline", "dev-administratoraccess", {
      _tag: "failed",
      failureClass: "authentication"
    })
    assert.include(message, "dev-administratoraccess")
    assert.include(message, "credentials or sign-in session")
    assert.notInclude(message, "Remove")
    assert.notInclude(message, "aws sso login")
  })

  it("keeps static-only profile authentication guidance source-neutral", () => {
    const message = discoveryFailureMessage("CodeCommit", "dev", { _tag: "failed", failureClass: "authentication" })
    assert.include(message, "credentials or sign-in session")
    assert.notInclude(message, "aws sso login")
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
