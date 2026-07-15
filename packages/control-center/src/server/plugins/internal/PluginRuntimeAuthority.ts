import * as Context from "effect/Context"
import * as Schema from "effect/Schema"

/** Opaque digest of the exact configured runtime generation backing an executor lease. */
export const PluginRuntimeAuthorityToken = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(512)
).pipe(Schema.brand("PluginRuntimeAuthorityToken"))

/** Decoded runtime-generation authority token. */
export type PluginRuntimeAuthorityToken = typeof PluginRuntimeAuthorityToken.Type

/** Internal runtime metadata acquired in the same scope as its executor. */
export class PluginRuntimeAuthority extends Context.Service<
  PluginRuntimeAuthority,
  PluginRuntimeAuthorityToken
>()("@knpkv/control-center/internal/PluginRuntimeAuthority") {}
