import { Data, Predicate, Schema } from "effect"
import * as AiError from "effect/unstable/ai/AiError"

const MAX_DIAGNOSTIC_CHARACTERS = 2_048

export class CodexTransportError extends Schema.TaggedErrorClass<CodexTransportError>()(
  "CodexTransportError",
  {
    cause: Schema.Defect(),
    diagnostic: Schema.String,
    phase: Schema.Literals(["configuration", "process", "protocol", "timeout"])
  }
) {}

export class CodexFailureCause extends Data.TaggedError("CodexFailureCause")<{
  readonly reason: string
}> {}

const SECRET_ASSIGNMENT = /(api[_-]?key|authorization|password|secret|token)\s*[:=]\s*([^\s,;]+)/giu
const BEARER_TOKEN = /bearer\s+[^\s,;]+/giu

export const sanitizeDiagnostic = (diagnostic: string): string =>
  diagnostic
    .replace(SECRET_ASSIGNMENT, "$1=[REDACTED]")
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .slice(0, MAX_DIAGNOSTIC_CHARACTERS)

export const invalidRequest = (method: string, parameter: string, description: string): AiError.AiError =>
  AiError.make({
    method,
    module: "CodexLanguageModel",
    reason: new AiError.InvalidRequestError({
      description,
      parameter
    })
  })

export const invalidOutput = (method: string, description: string): AiError.AiError =>
  AiError.make({
    method,
    module: "CodexLanguageModel",
    reason: new AiError.InvalidOutputError({ description })
  })

export const transportToAiError = (method: string, error: CodexTransportError): AiError.AiError =>
  AiError.make({
    method,
    module: "CodexLanguageModel",
    reason: new AiError.InternalProviderError({
      description: `Codex CLI ${error.phase} failure: ${sanitizeDiagnostic(error.diagnostic)}`,
      metadata: {
        "codex-cli": {
          cause: Predicate.isError(error.cause) ? error.cause.name : "typed-cause",
          phase: error.phase
        }
      }
    })
  })
