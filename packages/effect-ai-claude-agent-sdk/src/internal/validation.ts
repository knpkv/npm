/**
 * @internal
 * Input validation utilities.
 */

import { Effect } from "effect"
import * as AgentError from "../ClaudeAgentError.js"

/**
 * @internal
 * Validate that prompt is non-empty.
 */
export const validatePrompt = (prompt: string): Effect.Effect<string, AgentError.ValidationError> =>
  prompt.length > 0
    ? Effect.succeed(prompt)
    : Effect.fail(
      new AgentError.ValidationError({
        field: "prompt",
        message: "Prompt cannot be empty",
        input: prompt
      })
    )

/**
 * @internal
 * Validate that tools list doesn't contain both allowed and disallowed.
 */
export const validateToolLists = (options: {
  allowedTools?: ReadonlyArray<string>
  disallowedTools?: ReadonlyArray<string>
}): Effect.Effect<void, AgentError.ValidationError> =>
  options.allowedTools && options.disallowedTools
    ? Effect.fail(
      new AgentError.ValidationError({
        field: "tools",
        message: "Cannot specify both allowedTools and disallowedTools"
      })
    )
    : Effect.void

/**
 * @internal
 * Validate working directory if provided.
 */
export const validateWorkingDirectory = (
  workingDirectory?: string
): Effect.Effect<string | undefined, AgentError.ValidationError> =>
  !workingDirectory || workingDirectory.length > 0
    ? Effect.succeed(workingDirectory)
    : Effect.fail(
      new AgentError.ValidationError({
        field: "workingDirectory",
        message: "Working directory cannot be empty string",
        input: workingDirectory
      })
    )
