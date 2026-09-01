import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const SelectorId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(200)
).pipe(Schema.brand("RelaySelectorId"))

export const RelaySelectorOption = Schema.Struct({
  id: SelectorId,
  label: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200))
})
export interface RelaySelectorOption extends Schema.Schema.Type<typeof RelaySelectorOption> {}

const RelaySelectorStateInput = Schema.Struct({
  modelId: SelectorId,
  models: Schema.Array(RelaySelectorOption).check(Schema.isMinLength(1)),
  profileId: SelectorId,
  profiles: Schema.Array(RelaySelectorOption).check(Schema.isMinLength(1))
})

const hasUniqueOptionIds = (options: ReadonlyArray<RelaySelectorOption>): boolean =>
  new Set(options.map(({ id }) => id)).size === options.length

export const RelaySelectorState = RelaySelectorStateInput.check(
  Schema.makeFilter(({ profiles }) => hasUniqueOptionIds(profiles), {
    expected: "unique Relay profile option identifiers"
  }),
  Schema.makeFilter(({ models }) => hasUniqueOptionIds(models), {
    expected: "unique Relay model option identifiers"
  }),
  Schema.makeFilter(({ profileId, profiles }) => profiles.some(({ id }) => id === profileId), {
    expected: "a selected Relay profile present in the profile options"
  }),
  Schema.makeFilter(({ modelId, models }) => models.some(({ id }) => id === modelId), {
    expected: "a selected Relay model present in the model options"
  })
)
export interface RelaySelectorState extends Schema.Schema.Type<typeof RelaySelectorState> {}

export const RelayDockState = Schema.TaggedUnion({
  collapsed: {},
  expanded: {}
})
export type RelayDockState = typeof RelayDockState.Type

export const RelayState = Schema.Struct({
  dock: RelayDockState,
  selection: RelaySelectorState
})
export interface RelayState extends Schema.Schema.Type<typeof RelayState> {}

export class InvalidRelaySelectorState extends Schema.TaggedError<InvalidRelaySelectorState>()(
  "InvalidRelaySelectorState",
  {
    reason: Schema.Literals([
      "duplicate-model",
      "duplicate-profile",
      "invalid-input",
      "model-not-found",
      "profile-not-found"
    ])
  }
) {}

const decodeSelectorStateInput = Schema.decodeUnknownEffect(RelaySelectorStateInput)

/** Decode the visible selector state and initialize the product-owned dock as collapsed. */
export const makeInitialRelayState = Effect.fn("RelayProduct.makeInitialRelayState")(function*(
  input: typeof RelaySelectorStateInput.Encoded
) {
  const selection = yield* decodeSelectorStateInput(input).pipe(
    Effect.mapError(() => new InvalidRelaySelectorState({ reason: "invalid-input" }))
  )
  if (!hasUniqueOptionIds(selection.profiles)) {
    return yield* new InvalidRelaySelectorState({ reason: "duplicate-profile" })
  }
  if (!hasUniqueOptionIds(selection.models)) {
    return yield* new InvalidRelaySelectorState({ reason: "duplicate-model" })
  }
  if (!selection.profiles.some(({ id }) => id === selection.profileId)) {
    return yield* new InvalidRelaySelectorState({ reason: "profile-not-found" })
  }
  if (!selection.models.some(({ id }) => id === selection.modelId)) {
    return yield* new InvalidRelaySelectorState({ reason: "model-not-found" })
  }
  return RelayState.make({
    dock: RelayDockState.cases.collapsed.make({}),
    selection: RelaySelectorState.make(selection)
  })
})
