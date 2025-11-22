/**
 * Stream event schemas for Claude Code CLI stream-json output.
 *
 * Defines all event types returned by the CLI's --output-format stream-json.
 */
import * as Schema from "effect/Schema"

/**
 * Usage information for token consumption.
 *
 * @category Schemas
 */
export const Usage = Schema.Struct({
  input_tokens: Schema.Number,
  output_tokens: Schema.Number
})

export type Usage = Schema.Schema.Type<typeof Usage>

/**
 * Text content block.
 *
 * @category Schemas
 */
export const TextContentBlock = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String
})

/**
 * Tool input - any valid JSON value.
 *
 * Accepts null, boolean, number, string, array, or object.
 * This is explicitly unknown as tool inputs are arbitrary JSON.
 *
 * @category Schemas
 */
export const ToolInput = Schema.Unknown

export type ToolInput = Schema.Schema.Type<typeof ToolInput>

/**
 * Tool use content block.
 *
 * @category Schemas
 */
export const ToolUseContentBlock = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.optional(ToolInput)
})

/**
 * Thinking content block.
 *
 * @category Schemas
 */
export const ThinkingContentBlock = Schema.Struct({
  type: Schema.Literal("thinking")
})

/**
 * Union of all content block types.
 *
 * @category Schemas
 */
export const ContentBlock = Schema.Union(
  TextContentBlock,
  ToolUseContentBlock,
  ThinkingContentBlock
)

export type ContentBlock = Schema.Schema.Type<typeof ContentBlock>

/**
 * Message metadata from message_start event.
 *
 * @category Schemas
 */
export const Message = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("message"),
  role: Schema.Literal("assistant"),
  content: Schema.Array(ContentBlock),
  model: Schema.String,
  stop_reason: Schema.NullOr(Schema.String),
  stop_sequence: Schema.NullOr(Schema.String),
  usage: Usage
})

export type Message = Schema.Schema.Type<typeof Message>

/**
 * Message start event - indicates beginning of message.
 *
 * @category Schemas
 */
export const MessageStartEvent = Schema.Struct({
  type: Schema.Literal("message_start"),
  message: Message
})

export type MessageStartEvent = Schema.Schema.Type<typeof MessageStartEvent>

/**
 * Content block start event - indicates beginning of content block.
 *
 * @category Schemas
 */
export const ContentBlockStartEvent = Schema.Struct({
  type: Schema.Literal("content_block_start"),
  index: Schema.Number,
  content_block: ContentBlock
})

export type ContentBlockStartEvent = Schema.Schema.Type<typeof ContentBlockStartEvent>

/**
 * Text delta for streaming text content.
 *
 * @category Schemas
 */
export const TextDelta = Schema.Struct({
  type: Schema.Literal("text_delta"),
  text: Schema.String
})

export type TextDelta = Schema.Schema.Type<typeof TextDelta>

/**
 * Input JSON delta for streaming tool input construction.
 *
 * @category Schemas
 */
export const InputJsonDelta = Schema.Struct({
  type: Schema.Literal("input_json_delta"),
  partial_json: Schema.String
})

export type InputJsonDelta = Schema.Schema.Type<typeof InputJsonDelta>

/**
 * Content block delta event - contains incremental content (text or tool input).
 *
 * @category Schemas
 */
export const ContentBlockDeltaEvent = Schema.Struct({
  type: Schema.Literal("content_block_delta"),
  index: Schema.Number,
  delta: Schema.Union(TextDelta, InputJsonDelta)
})

export type ContentBlockDeltaEvent = Schema.Schema.Type<typeof ContentBlockDeltaEvent>

/**
 * Content block stop event - indicates end of content block.
 *
 * @category Schemas
 */
export const ContentBlockStopEvent = Schema.Struct({
  type: Schema.Literal("content_block_stop"),
  index: Schema.Number
})

export type ContentBlockStopEvent = Schema.Schema.Type<typeof ContentBlockStopEvent>

/**
 * Message delta metadata.
 *
 * @category Schemas
 */
export const MessageDelta = Schema.Struct({
  stop_reason: Schema.optional(Schema.String),
  stop_sequence: Schema.optional(Schema.NullOr(Schema.String))
})

export type MessageDelta = Schema.Schema.Type<typeof MessageDelta>

/**
 * Output usage information (for message_delta events).
 *
 * @category Schemas
 */
export const OutputUsage = Schema.Struct({
  output_tokens: Schema.Number
})

export type OutputUsage = Schema.Schema.Type<typeof OutputUsage>

/**
 * Message delta event - contains message metadata updates.
 *
 * @category Schemas
 */
export const MessageDeltaEvent = Schema.Struct({
  type: Schema.Literal("message_delta"),
  delta: MessageDelta,
  usage: Schema.optional(OutputUsage)
})

export type MessageDeltaEvent = Schema.Schema.Type<typeof MessageDeltaEvent>

/**
 * Message stop event - indicates end of message stream.
 *
 * @category Schemas
 */
export const MessageStopEvent = Schema.Struct({
  type: Schema.Literal("message_stop")
})

export type MessageStopEvent = Schema.Schema.Type<typeof MessageStopEvent>

/**
 * Union of all stream event types.
 *
 * @category Schemas
 */
export const StreamEvent = Schema.Union(
  MessageStartEvent,
  ContentBlockStartEvent,
  ContentBlockDeltaEvent,
  ContentBlockStopEvent,
  MessageDeltaEvent,
  MessageStopEvent
)

/**
 * Inferred type for stream events.
 *
 * @category Types
 */
export type StreamEvent = Schema.Schema.Type<typeof StreamEvent>

/**
 * Wrapped stream event format from CLI --output-format stream-json.
 *
 * The CLI wraps events in: {"type":"stream_event","event":{...}}
 *
 * @category Schemas
 */
export const WrappedStreamEvent = Schema.Struct({
  type: Schema.Literal("stream_event"),
  event: StreamEvent
})

export type WrappedStreamEvent = Schema.Schema.Type<typeof WrappedStreamEvent>

/**
 * Text chunk - represents streaming text content.
 *
 * @category Schemas
 */
export class TextChunk extends Schema.Class<TextChunk>("TextChunk")({
  /**
   * Chunk type discriminator
   */
  type: Schema.Literal("text"),
  /**
   * The text content delta
   */
  text: Schema.String,
  /**
   * The content block index
   */
  index: Schema.Number
}) {}

/**
 * Tool use start chunk - indicates a tool is being invoked.
 *
 * @category Schemas
 */
export class ToolUseStartChunk extends Schema.Class<ToolUseStartChunk>("ToolUseStartChunk")({
  /**
   * Chunk type discriminator
   */
  type: Schema.Literal("tool_use_start"),
  /**
   * Tool use ID
   */
  id: Schema.String,
  /**
   * Tool name
   */
  name: Schema.String,
  /**
   * The content block index
   */
  index: Schema.Number
}) {}

/**
 * Tool input chunk - represents streaming tool input JSON.
 *
 * @category Schemas
 */
export class ToolInputChunk extends Schema.Class<ToolInputChunk>("ToolInputChunk")({
  /**
   * Chunk type discriminator
   */
  type: Schema.Literal("tool_input"),
  /**
   * Partial JSON input
   */
  partialJson: Schema.String,
  /**
   * The content block index
   */
  index: Schema.Number
}) {}

/**
 * Content block start chunk - indicates start of a content block.
 *
 * @category Schemas
 */
export class ContentBlockStartChunk extends Schema.Class<ContentBlockStartChunk>("ContentBlockStartChunk")({
  /**
   * Chunk type discriminator
   */
  type: Schema.Literal("content_block_start"),
  /**
   * Content block type (text or tool_use)
   */
  blockType: Schema.String,
  /**
   * The content block index
   */
  index: Schema.Number
}) {}

/**
 * Content block stop chunk - indicates end of a content block.
 *
 * @category Schemas
 */
export class ContentBlockStopChunk extends Schema.Class<ContentBlockStopChunk>("ContentBlockStopChunk")({
  /**
   * Chunk type discriminator
   */
  type: Schema.Literal("content_block_stop"),
  /**
   * The content block index
   */
  index: Schema.Number
}) {}

/**
 * Message start chunk - indicates beginning of message with metadata.
 *
 * @category Schemas
 */
export class MessageStartChunk extends Schema.Class<MessageStartChunk>("MessageStartChunk")({
  /**
   * Chunk type discriminator
   */
  type: Schema.Literal("message_start"),
  /**
   * Message metadata
   */
  message: Message
}) {}

/**
 * Message delta chunk - contains message metadata updates (usage, stop_reason, etc).
 *
 * @category Schemas
 */
export class MessageDeltaChunk extends Schema.Class<MessageDeltaChunk>("MessageDeltaChunk")({
  /**
   * Chunk type discriminator
   */
  type: Schema.Literal("message_delta"),
  /**
   * Delta metadata
   */
  delta: MessageDelta,
  /**
   * Usage information
   */
  usage: Schema.optional(OutputUsage)
}) {}

/**
 * Message stop chunk - indicates end of message stream.
 *
 * @category Schemas
 */
export class MessageStopChunk extends Schema.Class<MessageStopChunk>("MessageStopChunk")({
  /**
   * Chunk type discriminator
   */
  type: Schema.Literal("message_stop")
}) {}

/**
 * Union of all chunk types.
 *
 * @category Schemas
 */
export const MessageChunk = Schema.Union(
  TextChunk,
  ToolUseStartChunk,
  ToolInputChunk,
  ContentBlockStartChunk,
  ContentBlockStopChunk,
  MessageStartChunk,
  MessageDeltaChunk,
  MessageStopChunk
)

/**
 * Inferred type for message chunks.
 *
 * @category Types
 */
export type MessageChunk = Schema.Schema.Type<typeof MessageChunk>
