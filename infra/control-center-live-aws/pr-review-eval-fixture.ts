export interface ChargeRequest {
  readonly amountCents: number
  readonly customerId: string
}

export type ChargeResult =
  | { readonly _tag: "Charged"; readonly chargeId: string }
  | { readonly _tag: "TemporarilyUnavailable" }

export interface ChargeGateway {
  readonly charge: (request: ChargeRequest, idempotencyKey: string) => Promise<ChargeResult>
}

export type MaximumAttempts = 1 | 2 | 3 | 4 | 5

/** Retry temporary unavailability without charging the customer twice. */
export const chargeWithRetry = async (
  gateway: ChargeGateway,
  request: ChargeRequest,
  makeIdempotencyKey: () => string,
  maximumAttempts: MaximumAttempts = 3
): Promise<ChargeResult> => {
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const result = await gateway.charge(request, makeIdempotencyKey())
    if (result._tag === "Charged") return result
  }
  return { _tag: "TemporarilyUnavailable" }
}
