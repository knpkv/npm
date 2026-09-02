import { serializeCredentialCookie } from "@knpkv/browser-pairing"
import type { CredentialCookieOptions, CsrfToken, PairingCode, SessionToken } from "@knpkv/browser-pairing/schema"
import type { Redacted } from "effect"

import type { Auth } from "../../src/server/auth/Auth.js"
import type { IssuedPairingCode, IssuedSession } from "../../src/server/auth/models.js"

declare const auth: Auth["Service"]
declare const issuedPairing: IssuedPairingCode
declare const issuedSession: IssuedSession

const pairingCredential: Redacted.Redacted<PairingCode> = issuedPairing.pairingCode
const sessionCredential: Redacted.Redacted<SessionToken> = issuedSession.sessionToken
const csrfCredential: Redacted.Redacted<CsrfToken> = issuedSession.csrfToken
void pairingCredential
void csrfCredential

// @ts-expect-error Pairing codes must not enter session-token operations.
const invalidConsume = auth.consumePairingCode(issuedSession.sessionToken)
void invalidConsume
// @ts-expect-error Pairing codes must not become CSRF proofs.
const invalidAuthorization = auth.authorizeMutation(issuedSession.sessionToken, issuedPairing.pairingCode)
void invalidAuthorization

const cookieOptions: CredentialCookieOptions = {
  name: "cc_session",
  path: "/",
  httpOnly: true,
  sameSite: "strict",
  secure: true
}
serializeCredentialCookie(sessionCredential, cookieOptions)
// @ts-expect-error Only session credentials may enter the cookie serializer.
serializeCredentialCookie(issuedPairing.pairingCode, cookieOptions)
