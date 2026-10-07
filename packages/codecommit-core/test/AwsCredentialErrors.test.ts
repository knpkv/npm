import * as AwsErrors from "@distilled.cloud/aws/Errors"
import { assert, describe, it } from "@effect/vitest"

import { isCredentialInvalidCause } from "../src/AwsCredentialErrors.js"

describe("isCredentialInvalidCause", () => {
  it("recognises an expired or rejected session from the provider's typed error", () => {
    assert.isTrue(isCredentialInvalidCause(new AwsErrors.ExpiredTokenException({ message: "expired" })))
  })

  it("recognises the wire tag of an error the provider client doesn't know", () => {
    const unknown = new AwsErrors.UnknownAwsError({
      errorTag: "UnrecognizedClientException",
      errorData: undefined,
      message: "The security token included in the request is invalid"
    })
    assert.isTrue(isCredentialInvalidCause(unknown))
  })

  it("keeps a missing grant out: the credentials work and the identity still holds", () => {
    assert.isFalse(isCredentialInvalidCause(new AwsErrors.AccessDeniedException({ message: "not authorized" })))
    const optIn = new AwsErrors.UnknownAwsError({ errorTag: "OptInRequired", errorData: undefined, message: "opt in" })
    assert.isFalse(isCredentialInvalidCause(optIn))
  })

  it("ignores values without a string tag", () => {
    assert.isFalse(isCredentialInvalidCause({ _tag: 7 }))
    assert.isFalse(isCredentialInvalidCause("ExpiredTokenException"))
  })
})
