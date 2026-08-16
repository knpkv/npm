/** Shared byte budgets for the bounded Relay prompt envelope. @module */
export const MAXIMUM_RELAY_PROMPT_BYTES = 1_048_576
export const MAXIMUM_RELAY_PATCH_BYTES = 786_432
export const MAXIMUM_RELAY_SKILL_PROMPT_BYTES = 131_072
export const MAXIMUM_RELAY_REVIEW_RESULT_BYTES = 65_536
export const MAXIMUM_RELAY_REVIEW_TURNS_BYTES = 32_768
export const MAXIMUM_RELAY_REVIEW_MESSAGE_BYTES = 8_000

/** Leave 128 KiB for host instructions, exact-revision metadata, and bounded session state. */
export const MINIMUM_RELAY_HOST_ENVELOPE_BYTES = MAXIMUM_RELAY_PROMPT_BYTES - MAXIMUM_RELAY_PATCH_BYTES -
  MAXIMUM_RELAY_SKILL_PROMPT_BYTES
