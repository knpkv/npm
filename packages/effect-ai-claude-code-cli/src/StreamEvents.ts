/**
 * Stream event schemas for Claude Code CLI stream-json output.
 *
 * Defines all event types returned by the CLI's --output-format stream-json.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema"

/**
 * Message start event - indicates beginning of message.
 *
 * @category Schemas
 * @since 1.0.0
 */
export class MessageStartEvent extends Schema.Class<MessageStartEvent>("MessageStartEvent")({
  type: Schema.Literal("message_start"),
  message: Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("message"),
    role: Schema.Literal("assistant"),
    model: Schema.String
  })
}) {}

/**
 * Content block start event - indicates beginning of content block.
 *
 * @category Schemas
 * @since 1.0.0
 */
export class ContentBlockStartEvent extends Schema.Class<ContentBlockStartEvent>("ContentBlockStartEvent")({
  type: Schema.Literal("content_block_start"),
  index: Schema.Number,
  content_block: Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String
  })
}) {}

/**
 * Content block delta event - contains incremental text content.
 *
 * @category Schemas
 * @since 1.0.0
 */
export class ContentBlockDeltaEvent extends Schema.Class<ContentBlockDeltaEvent>("ContentBlockDeltaEvent")({
  type: Schema.Literal("content_block_delta"),
  index: Schema.Number,
  delta: Schema.Struct({
    type: Schema.Literal("text_delta"),
    text: Schema.String
  })
}) {}

/**
 * Content block stop event - indicates end of content block.
 *
 * @category Schemas
 * @since 1.0.0
 */
export class ContentBlockStopEvent extends Schema.Class<ContentBlockStopEvent>("ContentBlockStopEvent")({
  type: Schema.Literal("content_block_stop"),
  index: Schema.Number
}) {}

/**
 * Message delta event - contains message metadata updates.
 *
 * @category Schemas
 * @since 1.0.0
 */
export class MessageDeltaEvent extends Schema.Class<MessageDeltaEvent>("MessageDeltaEvent")({
  type: Schema.Literal("message_delta"),
  delta: Schema.Struct({
    stop_reason: Schema.optional(Schema.Literal("end_turn", "max_tokens", "stop_sequence")),
    stop_sequence: Schema.optional(Schema.NullOr(Schema.String))
  }),
  usage: Schema.Struct({
    output_tokens: Schema.Number
  })
}) {}

/**
 * Message stop event - indicates end of message stream.
 *
 * @category Schemas
 * @since 1.0.0
 */
export class MessageStopEvent extends Schema.Class<MessageStopEvent>("MessageStopEvent")({
  type: Schema.Literal("message_stop")
}) {}

/**
 * Union of all stream event types.
 *
 * @category Schemas
 * @since 1.0.0
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
 * @since 1.0.0
 */
export type StreamEvent = Schema.Schema.Type<typeof StreamEvent>

/**
 * Message chunk representing a piece of streaming content.
 *
 * @category Schemas
 * @since 1.0.0
 */
export class MessageChunk extends Schema.Class<MessageChunk>("MessageChunk")({
  /**
   * The text content delta
   */
  text: Schema.String,
  /**
   * The content block index
   */
  index: Schema.Number
}) {}
