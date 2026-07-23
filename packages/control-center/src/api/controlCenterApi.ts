import { HttpApi } from "effect/unstable/httpapi"

import { AgentApiGroup } from "./agent.js"
import { DeliveryGraphApiGroup } from "./deliveryGraph.js"
import { DiffApiGroup } from "./diff.js"
import { LiveEventsApiGroup } from "./liveEvents.js"
import { MediaApiGroup } from "./media.js"
import { PluginsApiGroup } from "./plugins.js"
import { PortfolioApiGroup } from "./portfolio.js"
import { SessionApiGroup } from "./session.js"
import { SharesApiGroup } from "./shares.js"
import { TimelineApiGroup } from "./timeline.js"

/** Browser-safe authenticated HTTP contract shared by the generated client and server implementation. */
export class ControlCenterApi extends HttpApi.make("ControlCenterApi")
  .add(SessionApiGroup)
  .add(SharesApiGroup)
  .add(PluginsApiGroup)
  .add(PortfolioApiGroup)
  .add(DeliveryGraphApiGroup)
  .add(DiffApiGroup)
  .add(MediaApiGroup)
  .add(LiveEventsApiGroup)
  .add(TimelineApiGroup)
  .add(AgentApiGroup)
{}
