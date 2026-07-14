import * as Context from "effect/Context"
import * as Layer from "effect/Layer"

import type { BindConfig } from "../security/BindConfig.js"

/** Validated network binding policy consumed by HTTP authorization middleware. */
export class ApiBindConfiguration extends Context.Service<ApiBindConfiguration, BindConfig>()(
  "@knpkv/control-center/server/api/ApiBindConfiguration"
) {
  static readonly layer = (config: BindConfig) => Layer.succeed(ApiBindConfiguration, config)
}
