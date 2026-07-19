/** Provider-neutral selector seam for server-owned agent runtimes. @module */
import type { AgentProviderError, AgentProviderId, AgentRuntimeService } from "@knpkv/ai-runtime"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

/** Selects one configured runtime without exposing provider conditionals to workers. */
export interface AgentRuntimeRegistryService {
  readonly select: (
    providerId: AgentProviderId
  ) => Effect.Effect<AgentRuntimeService, AgentProviderError>
}

/** Server-owned registry for Codex, Claude, and deterministic runtime adapters. */
export class AgentRuntimeRegistry extends Context.Service<
  AgentRuntimeRegistry,
  AgentRuntimeRegistryService
>()("@knpkv/control-center/server/agent/AgentRuntimeRegistry") {}

/** Provides a selector implementation behind the runtime registry seam. */
export const agentRuntimeRegistryLayer = (
  select: AgentRuntimeRegistryService["select"]
): Layer.Layer<AgentRuntimeRegistry> => Layer.succeed(AgentRuntimeRegistry, AgentRuntimeRegistry.of({ select }))
