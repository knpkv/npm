/**
 * User home directory lookup as an Effect service.
 *
 * @module
 */
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

export interface HomeDirectoryShape {
  readonly path: string
}

export class HomeDirectory extends Context.Service<HomeDirectory, HomeDirectoryShape>()("jcf/HomeDirectory") {}

const homePath = Config.string("HOME").pipe(
  Config.orElse(() => Config.string("USERPROFILE")),
  Config.orElse(() => Config.succeed("/"))
)

export const layer = Layer.effect(
  HomeDirectory,
  homePath.pipe(Effect.map((path) => HomeDirectory.of({ path })))
)
