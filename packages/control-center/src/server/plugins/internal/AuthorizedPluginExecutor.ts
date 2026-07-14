import * as Context from "effect/Context"

import type { AuthorizedPluginExecutorV1 } from "../PluginExecutor.js"

/** Live executor tag kept declaration-visible inside the unexported internal module. */
export class AuthorizedPluginExecutor extends Context.Service<
  AuthorizedPluginExecutor,
  AuthorizedPluginExecutorV1
>()("@knpkv/control-center/internal/AuthorizedPluginExecutor") {}
