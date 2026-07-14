import { Data, Predicate, Schema } from "effect"
import { AiError } from "effect/unstable/ai"

const MODULE = "ClaudeCliLanguageModel"

export class ClaudeTransportError extends Schema.TaggedErrorClass<ClaudeTransportError>()(
  "ClaudeTransportError",
  {
    cause: Schema.Defect(),
    diagnostic: Schema.String,
    phase: Schema.Literals(["process", "timeout"])
  }
) {}

export class ClaudeFailureCause extends Data.TaggedError("ClaudeFailureCause")<{
  readonly reason: string
}> {}

export const invalidInput = (description: string, method: string): AiError.AiError =>
  AiError.make({
    module: MODULE,
    method,
    reason: new AiError.InvalidUserInputError({ description })
  })

export const invalidOutput = (description: string, method: string): AiError.AiError =>
  AiError.make({
    module: MODULE,
    method,
    reason: new AiError.InvalidOutputError({ description })
  })

export const configurationFailure = (cause: unknown, method: string): AiError.AiError =>
  AiError.make({
    module: MODULE,
    method,
    reason: new AiError.InternalProviderError({
      description: "Unable to read the reviewed Claude CLI environment",
      metadata: {
        "claude-cli": {
          cause: Predicate.isError(cause) ? cause.name : "typed-cause",
          phase: "configuration"
        }
      }
    })
  })

export const unsupportedSchema = (cause: unknown, method: string): AiError.AiError =>
  AiError.make({
    module: MODULE,
    method,
    reason: new AiError.UnsupportedSchemaError({
      description: Predicate.isError(cause) ? cause.message : "Claude CLI cannot represent the requested schema"
    })
  })

export const transportFailure = (
  phase: ClaudeTransportError["phase"],
  diagnostic: string,
  cause: unknown
): ClaudeTransportError => new ClaudeTransportError({ cause, diagnostic, phase })

export const transportToAiError = (error: ClaudeTransportError, method: string): AiError.AiError =>
  AiError.make({
    module: MODULE,
    method,
    reason: new AiError.InternalProviderError({
      description: `Claude CLI ${error.phase} failure: ${error.diagnostic}`,
      metadata: {
        "claude-cli": {
          cause: Predicate.isError(error.cause) ? error.cause.name : "typed-cause",
          phase: error.phase
        }
      }
    })
  })
