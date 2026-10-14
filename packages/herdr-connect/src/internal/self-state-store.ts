import { connectSqliteWrite } from "./sqlite-write.js"
/** Latest state and its token bucket share the post store's SQLite transaction and archive lifetime. */
import type { PrivateSqlite } from "@knpkv/herdr-fleet/sqlite"
import type { Semaphore } from "effect"
import { Effect, Schema } from "effect"
import type { DatabaseSync } from "node:sqlite"
import { ConnectPost, InvalidReport, Unavailable } from "../posts.js"
import { ConnectSelfBody, ConnectSelfState, TooManySelfUpdates } from "../self-model.js"

const Row = Schema.Struct({ state_json: Schema.String, tokens: Schema.Number, refilled_at: Schema.Number })
const StateJson = Schema.fromJsonString(ConnectSelfState)

export const makeSelfStateMethods = (
  database: DatabaseSync,
  transactions: Semaphore.Semaphore,
  secureFiles: PrivateSqlite["secureFiles"]
) => ({
  update: Effect.fn("AgentPostStore.selfUpdate")(
    function*(host: string, agentId: string, input: ConnectSelfBody, now: number) {
      const body = yield* Schema.decodeUnknownEffect(ConnectSelfBody, { onExcessProperty: "error" })(input).pipe(
        Effect.mapError(() =>
          new InvalidReport({ detail: "invalid self-state; provide mood or a trimmed say of 1-140 characters" })
        )
      )
      yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          host: ConnectPost.fields.host,
          agentId: ConnectPost.fields.agentId,
          at: ConnectSelfState.fields.at
        })
      )({ host, agentId, at: now }).pipe(
        Effect.mapError(() => new InvalidReport({ detail: "invalid self-state identity or timestamp" }))
      )
      return yield* connectSqliteWrite(
        "self.update",
        () => {
          database.exec("BEGIN IMMEDIATE")
          try {
            const raw = database.prepare(
              "SELECT state_json, tokens, refilled_at FROM connect_self_state WHERE host = ? AND agent_id = ?"
            ).get(host.toLowerCase(), agentId)
            const previous = raw === undefined ? null : Schema.decodeUnknownSync(Row)(raw)
            const refilledAt = Math.max(previous?.refilled_at ?? now, now)
            const tokens = previous === null
              ? 3
              : Math.min(3, previous.tokens + (refilledAt - previous.refilled_at) / 10_000)
            if (tokens < 1) throw new TooManySelfUpdates({ retryAfterMillis: Math.ceil((1 - tokens) * 10_000) })
            const priorState = previous === null ? null : Schema.decodeUnknownSync(StateJson)(previous.state_json)
            const self = Schema.decodeUnknownSync(ConnectSelfState)({
              ...priorState,
              ...body,
              accessory: body.accessory ?? priorState?.accessory ?? "none",
              at: now,
              replyTo: null
            })
            database.prepare(`INSERT INTO connect_self_state (host, agent_id, state_json, tokens, refilled_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(host, agent_id) DO UPDATE SET
              state_json = excluded.state_json, tokens = excluded.tokens, refilled_at = excluded.refilled_at`)
              .run(host.toLowerCase(), agentId, JSON.stringify(self), tokens - 1, refilledAt)
            database.exec("COMMIT")
            return self
          } catch (cause) {
            database.exec("ROLLBACK")
            throw cause
          }
        },
        (cause) => Schema.is(TooManySelfUpdates)(cause) ? cause : new Unavailable({ operation: "self.update" }),
        true,
        transactions,
        () => secureFiles.pipe(Effect.mapError(() => new Unavailable({ operation: "self.permissions" })))
      )
    }
  ),
  latestMany: Effect.fn("AgentPostStore.selfLatestMany")(
    function*(targets: ReadonlyArray<{ readonly host: string; readonly agentId: string }>) {
      return yield* transactions.withPermits(1)(Effect.try({
        try: () => {
          const query = database.prepare("SELECT state_json FROM connect_self_state WHERE host = ? AND agent_id = ?")
          return targets.flatMap(({ agentId, host }) => {
            const row = query.get(host.toLowerCase(), agentId)
            if (row === undefined) return []
            const stored = Schema.decodeUnknownSync(Schema.Struct({ state_json: Schema.String }))(row)
            return [{ host, agentId, self: Schema.decodeUnknownSync(StateJson)(stored.state_json) }]
          })
        },
        catch: () => new Unavailable({ operation: "self.read" })
      }))
    }
  )
})
