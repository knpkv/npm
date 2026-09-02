import { describe, expect, it } from "@effect/vitest"
import { Crypto, Effect, Encoding, Redacted, Result } from "effect"
import {
  bootstrapRouteWithoutToken,
  BrowserPairingError,
  CredentialCookieError,
  type CredentialCookieOptions,
  CredentialDigest,
  credentialValuesEqual,
  decideOneTimeCredential,
  expiresAt,
  hashCredential,
  isExpired,
  issueCredential,
  OneTimeCredentialState,
  readBootstrapToken,
  serializeCredentialCookie,
  verifyCredentialDigest
} from "../src/index.js"

const pairingCrypto = Crypto.Crypto.of({
  randomBytes: (size) => Effect.succeed(new Uint8Array(size).fill(0xab)),
  randomUUIDv4: Effect.succeed("00000000-0000-4000-8000-000000000000"),
  randomUUIDv7: Effect.succeed("01900000-0000-7000-8000-000000000000"),
  digest: (_algorithm, bytes) => Effect.succeed(new Uint8Array(32).fill(bytes[0] ?? 0))
})

const credential = Redacted.make("ab".repeat(32))

describe("browser pairing primitives", () => {
  it.effect("issues and hashes a redacted 256-bit credential", () =>
    Effect.gen(function*() {
      const issued = yield* issueCredential()
      expect(Redacted.value(issued)).toBe("ab".repeat(32))
      const digest = yield* hashCredential(credential)
      expect(digest).toBe(CredentialDigest.make(Encoding.encodeHex(new Uint8Array(32).fill(0xab))))
      yield* verifyCredentialDigest(credential, digest)
    }).pipe(Effect.provideService(Crypto.Crypto, pairingCrypto)))

  it.effect("rejects malformed credentials and digest mismatches", () =>
    Effect.gen(function*() {
      const malformed = yield* hashCredential(Redacted.make("short")).pipe(Effect.result)
      expect(Result.isFailure(malformed)).toBe(true)
      const mismatch = yield* verifyCredentialDigest(credential, "00".repeat(32)).pipe(Effect.result)
      expect(Result.isFailure(mismatch)).toBe(true)
      if (Result.isFailure(malformed)) expect(malformed.failure).toBeInstanceOf(BrowserPairingError)
    }).pipe(Effect.provideService(Crypto.Crypto, pairingCrypto)))

  it.effect("bounds expiry and treats the deadline as expired", () =>
    Effect.gen(function*() {
      expect(yield* expiresAt(100, 50)).toBe(150)
      expect(isExpired(150, 150)).toBe(true)
      const invalid = yield* expiresAt(100, 0).pipe(Effect.result)
      expect(Result.isFailure(invalid)).toBe(true)
    }))

  it("makes one-time persistence decisions in a stable order", () => {
    const active = OneTimeCredentialState.make({ expiresAt: 100, consumedAt: null, revokedAt: null })
    expect(decideOneTimeCredential(active, 99)).toBe("accepted")
    expect(decideOneTimeCredential({ ...active, expiresAt: 99 }, 99)).toBe("expired")
    expect(decideOneTimeCredential({ ...active, consumedAt: 1 }, 99)).toBe("consumed")
    expect(decideOneTimeCredential({ ...active, revokedAt: 1 }, 99)).toBe("revoked")
    expect(decideOneTimeCredential({ ...active, expiresAt: Number.NaN }, 99)).toBe("invalid")
    expect(decideOneTimeCredential(active, Number.POSITIVE_INFINITY)).toBe("invalid")
  })

  it("parses bootstrap fragments as missing, malformed, or present", () => {
    expect(readBootstrapToken("")).toEqual({ _tag: "missing" })
    expect(readBootstrapToken("#bootstrap_token=short")).toEqual({ _tag: "malformed" })
    const parsed = readBootstrapToken(`#bootstrap_token=${"ab".repeat(32)}`)
    expect(parsed._tag).toBe("present")
    if (parsed._tag === "present") {
      expect(Redacted.value(parsed.token)).toBe("ab".repeat(32))
      expect(String(parsed.token)).not.toContain("ab".repeat(32))
    }
    expect(bootstrapRouteWithoutToken("/pair", "?next=/home")).toBe("/pair?next=/home")
  })

  it("compares only valid credentials in constant time", () => {
    expect(credentialValuesEqual("ab".repeat(32), "ab".repeat(32))).toBe(true)
    expect(credentialValuesEqual("ab".repeat(32), "ac".repeat(32))).toBe(false)
    expect(credentialValuesEqual("short", "short")).toBe(false)
  })

  it("serializes application-selected cookie policy without exposing options to callers", () => {
    expect(serializeCredentialCookie(Redacted.value(credential), {
      name: "cc_session",
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: true
    })).toBe(`cc_session=${"ab".repeat(32)}; HttpOnly; Path=/; SameSite=Strict; Secure`)
  })

  it("rejects cookie delimiters, control characters, and invalid max ages", () => {
    const valid: CredentialCookieOptions = {
      name: "cc_session",
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: true
    }
    expect(() => serializeCredentialCookie("ab;" + "ab".repeat(31), valid)).toThrow(CredentialCookieError)
    expect(() => serializeCredentialCookie("ab".repeat(32), { ...valid, path: "/\r\nSet-Cookie: bad" })).toThrow(
      CredentialCookieError
    )
    expect(() => serializeCredentialCookie("ab".repeat(32), { ...valid, maxAge: -1 })).toThrow(CredentialCookieError)
    expect(() => serializeCredentialCookie("ab".repeat(32), { ...valid, maxAge: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      CredentialCookieError
    )
  })
})
