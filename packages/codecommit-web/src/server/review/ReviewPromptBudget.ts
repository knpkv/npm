/** Shared byte budgets for the bounded Relay prompt envelope. @module */
export const MAXIMUM_RELAY_PROMPT_BYTES = 1_048_576
export const MAXIMUM_RELAY_PATCH_BYTES = 786_432
export const MAXIMUM_RELAY_SKILL_PROMPT_BYTES = 131_072

/** Leave 128 KiB for host instructions, exact-revision metadata, and bounded session state. */
export const MINIMUM_RELAY_HOST_ENVELOPE_BYTES = MAXIMUM_RELAY_PROMPT_BYTES - MAXIMUM_RELAY_PATCH_BYTES -
  MAXIMUM_RELAY_SKILL_PROMPT_BYTES
