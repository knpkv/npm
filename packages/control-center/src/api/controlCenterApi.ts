import { HttpApi } from "effect/unstable/httpapi"

import { MediaApiGroup } from "./media.js"
import { PluginsApiGroup } from "./plugins.js"
import { PortfolioApiGroup } from "./portfolio.js"
import { SessionApiGroup } from "./session.js"

/** Browser-safe authenticated HTTP contract shared by the generated client and server implementation. */
export class ControlCenterApi extends HttpApi.make("ControlCenterApi")
  .add(SessionApiGroup)
  .add(PluginsApiGroup)
  .add(PortfolioApiGroup)
  .add(MediaApiGroup)
{}
