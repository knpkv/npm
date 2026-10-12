/** Agent-authored creature state. Identity comes from the authenticated host and CLI pane, never the body. */
import { Schema } from "effect"

export const ConnectSelfMood = Schema.Literals(["happy", "focused", "worried", "sleepy", "excited", "waiting"])
export type ConnectSelfMood = typeof ConnectSelfMood.Type

export const ConnectSelfAccessory = Schema.Literals(["none", "headphones", "chef-hat", "hard-hat", "scarf", "glasses"])
export type ConnectSelfAccessory = typeof ConnectSelfAccessory.Type
const Say = Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(140), Schema.isPattern(/^[^\p{Cc}]+$/u))
const hasSelfWordsOrMood = Schema.makeFilter(
  (state: { readonly mood?: ConnectSelfMood; readonly say?: string }) =>
    state.mood !== undefined || state.say !== undefined,
  { expected: "at least one of mood or say" }
)
export const ConnectSelfBody = Schema.Struct({
  mood: Schema.optionalKey(ConnectSelfMood),
  say: Schema.optionalKey(Say),
  accessory: Schema.optionalKey(ConnectSelfAccessory)
}).check(hasSelfWordsOrMood)
export type ConnectSelfBody = typeof ConnectSelfBody.Type
export const ConnectSelfState = Schema.Struct({
  mood: ConnectSelfBody.fields.mood,
  say: ConnectSelfBody.fields.say,
  accessory: ConnectSelfAccessory,
  at: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 })),
  replyTo: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)))
}).check(hasSelfWordsOrMood)
export type ConnectSelfState = typeof ConnectSelfState.Type
export class TooManySelfUpdates extends Schema.TaggedError<TooManySelfUpdates>()("TooManySelfUpdates", {
  retryAfterMillis: Schema.Int.check(Schema.isGreaterThan(0))
}) {}
