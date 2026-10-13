/** Stable identity is resolved only from the current Herdr pane and its lineage metadata. */
import { collectBoundedText } from "@knpkv/bounded-io"
import { Unavailable, UnboundAgent } from "@knpkv/herdr-connect"
import { AgentStableId, AgentWorkerIdentity } from "@knpkv/herdr-fleet/model"
import { Effect, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

const ReportingPane = Schema.fromJsonString(Schema.Struct({
  result: Schema.Struct({
    agent: Schema.Struct({
      agent: Schema.String,
      pane_id: AgentWorkerIdentity.fields.paneId,
      tokens: Schema.Struct({ agent_id: AgentStableId, lineage_version: Schema.Literal("hostd.agent-lineage.v1") })
    })
  })
}))

/** Resolve only the current pane's stable identity. There is no caller-supplied agent override. */
export const resolveReportingAgent = Effect.fn("Relay.resolveReportingAgent")(
  function*(command: string, paneId: string) {
    yield* Schema.decodeUnknownEffect(AgentWorkerIdentity.fields.paneId)(paneId).pipe(
      Effect.mapError(() => new UnboundAgent({ agentId: "current-pane" }))
    )
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return yield* Effect.scoped(Effect.gen(function*() {
      const handle = yield* spawner.spawn(ChildProcess.make(command, ["agent", "get", paneId])).pipe(
        Effect.mapError(() => new Unavailable({ operation: "post.identity" }))
      )
      const [output, , exitCode] = yield* Effect.all([
        collectBoundedText(handle.stdout, 64 * 1024),
        collectBoundedText(handle.stderr, 64 * 1024),
        handle.exitCode
      ], { concurrency: "unbounded" }).pipe(Effect.mapError(() => new Unavailable({ operation: "post.identity" })))
      if (exitCode !== ChildProcessSpawner.ExitCode(0)) return yield* new UnboundAgent({ agentId: "current-pane" })
      const parsed = yield* Schema.decodeUnknownEffect(ReportingPane)(output).pipe(
        Effect.mapError(() => new UnboundAgent({ agentId: "current-pane" }))
      )
      if (parsed.result.agent.pane_id !== paneId) return yield* new UnboundAgent({ agentId: "current-pane" })
      return parsed.result.agent.tokens.agent_id
    })).pipe(Effect.timeoutOrElse({
      duration: "3 seconds",
      orElse: () => Effect.fail(new Unavailable({ operation: "post.identity.timeout" }))
    }))
  }
)
