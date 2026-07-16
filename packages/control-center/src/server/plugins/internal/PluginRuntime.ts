import * as Context from "effect/Context"
import * as Layer from "effect/Layer"

import type { PluginConnectionV1 } from "../PluginConnection.js"
import { PluginConnection } from "../PluginConnection.js"
import type { AuthorizedPluginExecutorV1 } from "../PluginExecutor.js"
import { AuthorizedPluginExecutor } from "./AuthorizedPluginExecutor.js"

/** Both halves of one scoped adapter runtime before authority projection. */
export interface PluginRuntimeV1 {
  readonly connection: PluginConnectionV1
  readonly executor: AuthorizedPluginExecutorV1
}

/** Build the internal runtime layer while keeping execution out of the public connection shape. */
export const pluginRuntimeLayer = (
  runtime: PluginRuntimeV1
): Layer.Layer<PluginConnection | AuthorizedPluginExecutor> =>
  Layer.succeedContext(
    Context.make(PluginConnection, runtime.connection).pipe(Context.add(AuthorizedPluginExecutor, runtime.executor))
  )
