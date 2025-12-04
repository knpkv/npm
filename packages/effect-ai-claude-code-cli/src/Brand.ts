/**
 * Branded types for type-safe identifiers and values.
 */

import * as Brand from "effect/Brand"
import * as Schema from "effect/Schema"

/**
 * A branded type for tool names.
 *
 * Ensures tool names are non-empty strings that match expected format.
 *
 * @category Brands
 */
export type ToolName = string & Brand.Brand<"ToolName">

/**
 * Schema for validating and constructing ToolName.
 *
 * @category Schemas
 */
export const ToolNameSchema = Schema.String.pipe(
  Schema.nonEmptyString(),
  Schema.pattern(/^[A-Z][a-zA-Z]*$/),
  Schema.brand("ToolName")
)

/**
 * Constructs a ToolName from a string with validation.
 *
 * @category Constructors
 * @example
 *   import { ToolName } from "@knpkv/effect-ai-claude-code-cli"
 *
 *   const name = ToolName.make("Read") // Effect<ToolName, ParseError>
 */
export const ToolName = Brand.refined<ToolName>(
  (s): s is ToolName & string => Schema.is(ToolNameSchema)(s),
  (s) => Brand.error(`Invalid tool name: ${s}. Must be PascalCase non-empty string.`)
)

/**
 * Unsafe constructor for ToolName (for internal use only).
 *
 * @internal
 */
export const unsafeToolName = (s: string): ToolName => s as ToolName

/**
 * A branded type for Claude model identifiers.
 *
 * @category Brands
 */
export type ModelId = string & Brand.Brand<"ModelId">

/**
 * Schema for validating and constructing ModelId.
 *
 * @category Schemas
 */
export const ModelIdSchema = Schema.String.pipe(
  Schema.nonEmptyString(),
  Schema.pattern(/^claude-/),
  Schema.brand("ModelId")
)

/**
 * Constructs a ModelId from a string with validation.
 *
 * @category Constructors
 * @example
 *   import { ModelId } from "@knpkv/effect-ai-claude-code-cli"
 *
 *   const model = ModelId.make("claude-4-sonnet-20250514") // Effect<ModelId, ParseError>
 */
export const ModelId = Brand.refined<ModelId>(
  (s): s is ModelId & string => Schema.is(ModelIdSchema)(s),
  (s) => Brand.error(`Invalid model ID: ${s}. Must start with 'claude-'.`)
)

/**
 * Unsafe constructor for ModelId (for internal use only).
 *
 * @internal
 */
export const unsafeModelId = (s: string): ModelId => s as ModelId

/**
 * A branded type for file paths.
 *
 * @category Brands
 */
export type FilePath = string & Brand.Brand<"FilePath">

/**
 * Schema for validating and constructing FilePath.
 *
 * Validates path is non-empty and doesn't contain null bytes or path traversal.
 *
 * @category Schemas
 */
export const FilePathSchema = Schema.String.pipe(
  Schema.nonEmptyString(),
  Schema.filter((s) => !s.includes("\0"), {
    message: () => "File path must not contain null bytes"
  }),
  Schema.filter((s) => !s.includes(".."), {
    message: () => "File path must not contain path traversal"
  }),
  Schema.brand("FilePath")
)

/**
 * Constructs a FilePath from a string with validation.
 *
 * @category Constructors
 * @example
 *   import { FilePath } from "@knpkv/effect-ai-claude-code-cli"
 *
 *   const path = FilePath.make("/home/user/file.txt") // Effect<FilePath, ParseError>
 */
export const FilePath = Brand.refined<FilePath>(
  (s): s is FilePath & string => Schema.is(FilePathSchema)(s),
  (s) => Brand.error(`Invalid file path: ${s}`)
)

/**
 * Unsafe constructor for FilePath (for internal use only).
 *
 * @internal
 */
export const unsafeFilePath = (s: string): FilePath => s as FilePath

/**
 * A branded type for prompt text.
 *
 * Ensures prompts are non-empty.
 *
 * @category Brands
 */
export type PromptText = string & Brand.Brand<"PromptText">

/**
 * Schema for validating and constructing PromptText.
 *
 * @category Schemas
 */
export const PromptTextSchema = Schema.String.pipe(
  Schema.nonEmptyString(),
  Schema.trimmed(),
  Schema.brand("PromptText")
)

/**
 * Constructs a PromptText from a string with validation.
 *
 * @category Constructors
 * @example
 *   import { PromptText } from "@knpkv/effect-ai-claude-code-cli"
 *
 *   const prompt = PromptText.make("Explain TypeScript") // Effect<PromptText, ParseError>
 */
export const PromptText = Brand.refined<PromptText>(
  (s): s is PromptText & string => Schema.is(PromptTextSchema)(s),
  (_s) => Brand.error(`Invalid prompt text: must be non-empty trimmed string`)
)

/**
 * Unsafe constructor for PromptText (for internal use only).
 *
 * @internal
 */
export const unsafePromptText = (s: string): PromptText => s as PromptText

/**
 * A branded type for stream event IDs.
 *
 * @category Brands
 */
export type EventId = string & Brand.Brand<"EventId">

/**
 * Schema for validating and constructing EventId.
 *
 * @category Schemas
 */
export const EventIdSchema = Schema.String.pipe(
  Schema.nonEmptyString(),
  Schema.brand("EventId")
)

/**
 * Constructs an EventId from a string with validation.
 *
 * @category Constructors
 */
export const EventId = Brand.refined<EventId>(
  (s): s is EventId & string => Schema.is(EventIdSchema)(s),
  (s) => Brand.error(`Invalid event ID: ${s}`)
)

/**
 * Unsafe constructor for EventId (for internal use only).
 *
 * @internal
 */
export const unsafeEventId = (s: string): EventId => s as EventId

/**
 * A branded type for content block IDs.
 *
 * @category Brands
 */
export type BlockId = string & Brand.Brand<"BlockId">

/**
 * Schema for validating and constructing BlockId.
 *
 * @category Schemas
 */
export const BlockIdSchema = Schema.String.pipe(
  Schema.nonEmptyString(),
  Schema.brand("BlockId")
)

/**
 * Constructs a BlockId from a string with validation.
 *
 * @category Constructors
 */
export const BlockId = Brand.refined<BlockId>(
  (s): s is BlockId & string => Schema.is(BlockIdSchema)(s),
  (s) => Brand.error(`Invalid block ID: ${s}`)
)

/**
 * Unsafe constructor for BlockId (for internal use only).
 *
 * @internal
 */
export const unsafeBlockId = (s: string): BlockId => s as BlockId

/**
 * A branded type for session identifiers.
 *
 * Ensures session IDs conform to UUID v4 format.
 *
 * @category Brands
 */
export type SessionId = string & Brand.Brand<"SessionId">

/**
 * Schema for validating and constructing SessionId.
 *
 * @category Schemas
 */
export const SessionIdSchema = Schema.UUID.pipe(Schema.brand("SessionId"))

/**
 * Constructs a SessionId from a string with validation.
 *
 * @category Constructors
 * @example
 *   import { SessionId } from "@knpkv/effect-ai-claude-code-cli/Brand"
 *   import { Effect } from "effect"
 *
 *   const program = Effect.gen(function* () {
 *     const sessionId = yield* SessionId.make("631f187f-fd79-41d9-9cae-cb255c96acfd")
 *     console.log(sessionId)
 *   })
 */
export const SessionId = Brand.refined<SessionId>(
  (s): s is SessionId & string => Schema.is(SessionIdSchema)(s),
  (s) => Brand.error(`Invalid session ID: ${s}. Must be UUID v4 format.`)
)

/**
 * Unsafe constructor for SessionId (for internal use only).
 *
 * @internal
 */
export const unsafeSessionId = (s: string): SessionId => s as SessionId
