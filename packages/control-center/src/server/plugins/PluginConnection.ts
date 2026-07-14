import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type * as Stream from "effect/Stream"

import type { PluginHealth } from "../../domain/freshness.js"
import type {
  DiffContentRangeRequestV1,
  DiffContentRangeV1,
  DiffInventoryPageRequestV1,
  DiffInventoryPageV1,
  NegotiatedPluginDescriptorV1,
  PluginActionProposalV1,
  PluginDiscoveryV1,
  PluginSyncPageV1,
  PluginSyncRequestV1,
  ProposePluginActionRequestV1,
  ReadPluginEntityRequestV1,
  ReadPluginEntityResultV1
} from "../../domain/plugins/index.js"
import type { PluginFailure } from "./failures.js"

/** Optional complete-diff reads negotiated independently from entity reads. */
export interface PluginDiffReaderV1 {
  readonly readInventoryPage: (
    request: DiffInventoryPageRequestV1
  ) => Effect.Effect<DiffInventoryPageV1, PluginFailure>
  readonly readContentRange: (
    request: DiffContentRangeRequestV1
  ) => Effect.Effect<DiffContentRangeV1, PluginFailure>
}

/** Safe plugin surface available to application reads and action proposals. */
export interface PluginConnectionV1 {
  readonly descriptor: NegotiatedPluginDescriptorV1
  readonly discover: Effect.Effect<PluginDiscoveryV1, PluginFailure>
  readonly health: Effect.Effect<PluginHealth, PluginFailure>
  readonly sync: (
    request: PluginSyncRequestV1
  ) => Stream.Stream<PluginSyncPageV1, PluginFailure>
  readonly readEntity: (
    request: ReadPluginEntityRequestV1
  ) => Effect.Effect<ReadPluginEntityResultV1, PluginFailure>
  readonly diff: Option.Option<PluginDiffReaderV1>
  readonly proposeAction: (
    request: ProposePluginActionRequestV1
  ) => Effect.Effect<PluginActionProposalV1, PluginFailure>
}

/** Effect service for one scoped, capability-negotiated plugin connection. */
export class PluginConnection extends Context.Service<PluginConnection, PluginConnectionV1>()(
  "@knpkv/control-center/PluginConnection"
) {}
