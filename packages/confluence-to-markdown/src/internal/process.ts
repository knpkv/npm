/**
 * Process metadata service.
 *
 * @module
 * @internal
 */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"

export class ProcessArgs extends Context.Service<
  ProcessArgs,
  {
    readonly argv: Effect.Effect<ReadonlyArray<string>>
  }
>()("@knpkv/confluence-to-markdown/ProcessArgs") {}
