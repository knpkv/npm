import { CsrfToken, PairingCode, SessionToken } from "../src/schema.js"

const pairingCode = PairingCode.make("ab".repeat(32))
const sessionToken = SessionToken.make("cd".repeat(32))
const csrfToken = CsrfToken.make("ef".repeat(32))

const acceptsPairingCode = (value: PairingCode): PairingCode => value
const acceptsSessionToken = (value: SessionToken): SessionToken => value
const acceptsCsrfToken = (value: CsrfToken): CsrfToken => value

acceptsPairingCode(pairingCode)
acceptsSessionToken(sessionToken)
acceptsCsrfToken(csrfToken)

// @ts-expect-error Role brands must not be interchangeable.
acceptsCsrfToken(pairingCode)
// @ts-expect-error Role brands must not be interchangeable.
acceptsSessionToken(pairingCode)
// @ts-expect-error Role brands must not be interchangeable.
acceptsPairingCode(csrfToken)
