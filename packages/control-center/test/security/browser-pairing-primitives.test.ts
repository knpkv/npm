import { describe, expect, it } from "@effect/vitest"
import { Crypto, Effect, Result, Schema } from "effect"
import { CsrfToken, PairingCode, PairSessionRequest } from "../../src/api/session.js"
import { hashCsrfToken, verifyCsrfToken } from "../../src/server/security/RequestSecurity.js"

const pairingCode = "ab".repeat(32)

describe("Control Center browser pairing seam", () => {
  it("shares the strict pairing and CSRF credential contract", () => {
    expect(Result.isSuccess(Schema.decodeUnknownResult(PairingCode)(pairingCode))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(PairingCode)("short"))).toBe(true)
    expect(Result.isSuccess(Schema.decodeUnknownResult(PairSessionRequest)({ pairingCode }))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(CsrfToken)("not-a-token"))).toBe(true)
  })

  it.effect("uses the shared CSRF digest verifier while keeping request policy local", () =>
    Effect.gen(function*() {
      const digest = yield* hashCsrfToken(pairingCode)
      yield* verifyCsrfToken(pairingCode, digest)
    }).pipe(Effect.provideService(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(0xab),
        digest: () => Effect.succeed(new Uint8Array(32).fill(0xab))
      })
    )))
})
