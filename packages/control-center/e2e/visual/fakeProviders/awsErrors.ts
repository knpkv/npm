import type { ProviderScenario } from "./transport.js"

interface AwsServiceFailure {
  readonly status: number
  readonly errorType: string
  readonly queryCode: string
}

const errors = new Map<ProviderScenario, AwsServiceFailure>([
  ["401", { status: 400, errorType: "UnrecognizedClientException", queryCode: "InvalidClientTokenId" }],
  ["expired-token", { status: 400, errorType: "ExpiredTokenException", queryCode: "ExpiredToken" }],
  ["invalid-signature", { status: 403, errorType: "InvalidSignatureException", queryCode: "SignatureDoesNotMatch" }],
  ["403", { status: 403, errorType: "AccessDeniedException", queryCode: "AccessDenied" }],
  ["429", { status: 400, errorType: "ThrottlingException", queryCode: "Throttling" }],
  ["503", { status: 503, errorType: "ServiceUnavailableException", queryCode: "ServiceUnavailable" }]
])

/** AWS JSON services expose wire error codes; STS uses the corresponding Query XML envelope. */
export const awsErrorResponse = (scenario: ProviderScenario, query = false) => {
  const error = errors.get(scenario)
  if (error === undefined) return undefined
  const message = "Fixture AWS request rejected"
  const json = { __type: error.errorType, message }
  return {
    status: error.status,
    errorType: error.errorType,
    json,
    body: query
      ? `<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><Error><Type>Sender</Type><Code>${error.queryCode}</Code><Message>${message}</Message></Error><RequestId>fixture-request</RequestId></ErrorResponse>`
      : JSON.stringify(json),
    headers: {
      "content-type": query ? "text/xml" : "application/x-amz-json-1.1",
      "x-amzn-errortype": error.errorType
    }
  }
}
