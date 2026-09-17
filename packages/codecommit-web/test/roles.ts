import type { OwnerSessionSecretsContract } from "../src/server/internal/OwnerSessionSecurity.js"

declare const secrets: OwnerSessionSecretsContract

// @ts-expect-error Session cookies must not accept the CSRF role.
const ownerWithCsrf: OwnerSessionSecretsContract = { ...secrets, ownerToken: secrets.csrfToken }
void ownerWithCsrf

// @ts-expect-error Bootstrap URL credentials must not accept the session role.
const bootstrapWithSession: OwnerSessionSecretsContract = { ...secrets, bootstrapToken: secrets.ownerToken }
void bootstrapWithSession

// @ts-expect-error CSRF proofs must not accept the bootstrap role.
const csrfWithPairing: OwnerSessionSecretsContract = { ...secrets, csrfToken: secrets.bootstrapToken }
void csrfWithPairing
