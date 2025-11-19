import * as Effect from "effect/Effect"

export const greet = (name: string): Effect.Effect<string> => Effect.sync(() => `Hello, ${name}!`)

export const greetWithPrefix = (prefix: string, name: string): Effect.Effect<string> =>
  Effect.sync(() => `${prefix}, ${name}!`)
