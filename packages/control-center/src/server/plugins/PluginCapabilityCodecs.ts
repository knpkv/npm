import {
  AuthorizedPluginActionV1,
  DiffContentRangeRequestV1,
  DiffContentRangeRequestV2,
  DiffContentRangeV1,
  DiffInventoryPageRequestV1,
  DiffInventoryPageRequestV2,
  DiffInventoryPageV1,
  PluginActionCancellationRequestV1,
  PluginActionCancellationResultV1,
  PluginActionDispatchResultV1,
  PluginActionPreflightV1,
  PluginActionProposalV1,
  PluginActionReconciliationRequestV1,
  PluginActionReconciliationResultV1,
  PluginSyncPageV1,
  PluginSyncRequestV1,
  ProposePluginActionRequestV1,
  ReadPluginEntityRequestV1,
  ReadPluginEntityResultV1
} from "../../domain/plugins/index.js"

interface CapabilityCodecV1 {
  readonly version: 1
}
interface CapabilityCodecV2 {
  readonly version: 2
}

/** Adapter-registered codecs for every version-one capability boundary it offers. */
export interface PluginCapabilityCodecsV1 {
  readonly entityRead?: CapabilityCodecV1 & {
    readonly input: typeof ReadPluginEntityRequestV1
    readonly output: typeof ReadPluginEntityResultV1
  }
  readonly syncIncremental?: CapabilityCodecV1 & {
    readonly input: typeof PluginSyncRequestV1
    readonly output: typeof PluginSyncPageV1
  }
  readonly actionPropose?: CapabilityCodecV1 & {
    readonly input: typeof ProposePluginActionRequestV1
    readonly output: typeof PluginActionProposalV1
  }
  readonly actionExecute?: CapabilityCodecV1 & {
    readonly input: typeof AuthorizedPluginActionV1
    readonly preflightOutput: typeof PluginActionPreflightV1
    readonly dispatchOutput: typeof PluginActionDispatchResultV1
  }
  readonly actionCancel?: CapabilityCodecV1 & {
    readonly input: typeof PluginActionCancellationRequestV1
    readonly output: typeof PluginActionCancellationResultV1
  }
  readonly actionReconcile?: CapabilityCodecV1 & {
    readonly input: typeof PluginActionReconciliationRequestV1
    readonly output: typeof PluginActionReconciliationResultV1
  }
  readonly diffInventory?: CapabilityCodecV1 & {
    readonly input: typeof DiffInventoryPageRequestV1
    readonly output: typeof DiffInventoryPageV1
  }
  readonly diffContent?: CapabilityCodecV1 & {
    readonly input: typeof DiffContentRangeRequestV1
    readonly output: typeof DiffContentRangeV1
  }
  readonly diffInventoryV2?: CapabilityCodecV2 & {
    readonly input: typeof DiffInventoryPageRequestV2
    readonly output: typeof DiffInventoryPageV1
  }
  readonly diffContentV2?: CapabilityCodecV2 & {
    readonly input: typeof DiffContentRangeRequestV2
    readonly output: typeof DiffContentRangeV1
  }
}

/** Canonical host codecs adapters explicitly register for negotiated v1 capabilities. */
export const pluginCapabilityCodecsV1 = {
  entityRead: {
    version: 1,
    input: ReadPluginEntityRequestV1,
    output: ReadPluginEntityResultV1
  },
  syncIncremental: {
    version: 1,
    input: PluginSyncRequestV1,
    output: PluginSyncPageV1
  },
  actionPropose: {
    version: 1,
    input: ProposePluginActionRequestV1,
    output: PluginActionProposalV1
  },
  actionExecute: {
    version: 1,
    input: AuthorizedPluginActionV1,
    preflightOutput: PluginActionPreflightV1,
    dispatchOutput: PluginActionDispatchResultV1
  },
  actionCancel: {
    version: 1,
    input: PluginActionCancellationRequestV1,
    output: PluginActionCancellationResultV1
  },
  actionReconcile: {
    version: 1,
    input: PluginActionReconciliationRequestV1,
    output: PluginActionReconciliationResultV1
  },
  diffInventory: {
    version: 1,
    input: DiffInventoryPageRequestV1,
    output: DiffInventoryPageV1
  },
  diffContent: {
    version: 1,
    input: DiffContentRangeRequestV1,
    output: DiffContentRangeV1
  },
  diffInventoryV2: {
    version: 2,
    input: DiffInventoryPageRequestV2,
    output: DiffInventoryPageV1
  },
  diffContentV2: {
    version: 2,
    input: DiffContentRangeRequestV2,
    output: DiffContentRangeV1
  }
} satisfies PluginCapabilityCodecsV1
