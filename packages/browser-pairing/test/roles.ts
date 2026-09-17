import type { Redacted } from "effect"
import { CsrfToken, PairingCode, readBootstrapToken, SessionToken } from "../src/schema.js"
import type { CredentialCookieOptions } from "../src/schema.js"

const pairingCode = PairingCode.make("ab".repeat(32))
const sessionToken = SessionToken.make("cd".repeat(32))
const csrfToken = CsrfToken.make("ef".repeat(32))

const acceptsPairingCode = (value: PairingCode): PairingCode => value
const acceptsSessionToken = (value: SessionToken): SessionToken => value
const acceptsCsrfToken = (value: CsrfToken): CsrfToken => value

acceptsPairingCode(pairingCode)
acceptsSessionToken(sessionToken)
acceptsCsrfToken(csrfToken)

const secureCookieOptions: CredentialCookieOptions = {
  name: "cc_session",
  path: "/",
  httpOnly: true,
  sameSite: "strict",
  secure: true,
  sourceOrigin: "https://example.test"
}
void secureCookieOptions

// @ts-expect-error Secure cookies must carry the origin used to establish trust.
const missingSecureCookieOrigin: CredentialCookieOptions = {
  name: "cc_session",
  path: "/",
  httpOnly: true,
  sameSite: "strict",
  secure: true
}
void missingSecureCookieOrigin

const bootstrap = readBootstrapToken(`#bootstrap_token=${"ab".repeat(32)}`)
if (bootstrap._tag === "present") {
  const pairingCredential: Redacted.Redacted<PairingCode> = bootstrap.token
  void pairingCredential
  // @ts-expect-error Bootstrap URL credentials must not become session-cookie credentials.
  const sessionCredential: Redacted.Redacted<SessionToken> = bootstrap.token
  void sessionCredential
}

// @ts-expect-error Role brands must not be interchangeable.
acceptsCsrfToken(pairingCode)
// @ts-expect-error Role brands must not be interchangeable.
acceptsSessionToken(pairingCode)
// @ts-expect-error Role brands must not be interchangeable.
acceptsPairingCode(csrfToken)
