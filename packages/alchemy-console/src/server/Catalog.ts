import { Context, Crypto, Effect, Layer, Ref, Schema, Semaphore } from "effect"
import { CatalogReadError, StackNotFound, StackSummary } from "../api.js"
import type { DiscoveryIssue, StackDetail, StackId, StackList } from "../api.js"
import { type OutputSummary, type ResourceSummary, type StackState } from "../schema.js"

/** Server-private locator identity and read closure. Never serialize or retain in logs or browser storage. */
export interface DiscoveredStack {
  readonly key: string
  readonly summary: Omit<StackSummary, "id">
  readonly read: Effect.Effect<StackState, CatalogReadError>
}

export class StackSource extends Context.Service<StackSource, {
  readonly discover: Effect.Effect<{
    readonly stacks: ReadonlyArray<DiscoveredStack>
    readonly issues: ReadonlyArray<DiscoveryIssue>
  }, CatalogReadError>
}>()("@knpkv/alchemy-console/StackSource") {}

export class Catalog extends Context.Service<Catalog, {
  readonly list: Effect.Effect<StackList, CatalogReadError>
  readonly identify: (id: StackId) => Effect.Effect<Omit<StackSummary, "id">, StackNotFound>
  readonly get: (id: StackId) => Effect.Effect<StackDetail, StackNotFound | CatalogReadError>
}>()("@knpkv/alchemy-console/Catalog") {
  static readonly layer = Layer.effect(
    Catalog,
    Effect.gen(function*() {
      const source = yield* StackSource
      const cryptoService = yield* Crypto.Crypto
      const entries = yield* Ref.make<ReadonlyMap<StackId, DiscoveredStack>>(new Map())
      const lock = yield* Semaphore.make(1)
      const list = Effect.fn("AlchemyConsole.catalogList")(
        function*() {
          const discovered = yield* source.discover
          if (discovered.stacks.length > 1000 || discovered.issues.length > 1000) {
            return yield* new CatalogReadError({ reason: "limit" })
          }
          const current = yield* Ref.get(entries)
          const previous = new Map([...current].map(([id, entry]) => [entry.key, id]))
          const next = new Map<StackId, DiscoveredStack>()
          const keys = new Set<string>()
          const summaries: Array<StackSummary> = []
          for (const entry of discovered.stacks) {
            if (keys.has(entry.key)) return yield* new CatalogReadError({ reason: "invalid-source" })
            keys.add(entry.key)
            const id = previous.get(entry.key) ?? (yield* cryptoService.randomUUIDv4.pipe(
              Effect.mapError(() => new CatalogReadError({ reason: "io" }))
            ))
            const summary = yield* Schema.decodeUnknownEffect(StackSummary)({
              id,
              app: entry.summary.app,
              stage: entry.summary.stage,
              backend: entry.summary.backend,
              alchemyVersion: entry.summary.alchemyVersion,
              lastDeploy: entry.summary.lastDeploy,
              resourceCount: entry.summary.resourceCount
            }).pipe(Effect.mapError(() => new CatalogReadError({ reason: "invalid-source" })))
            next.set(id, entry)
            summaries.push(summary)
          }
          const issues = discovered.issues.map((issue) => ({ source: issue.source, reason: issue.reason }))
          yield* Ref.set(entries, next)
          return { stacks: summaries, issues }
        },
        lock.withPermit,
        Effect.timeoutOrElse({
          duration: "2 minutes",
          orElse: () => Effect.fail(new CatalogReadError({ reason: "limit" }))
        })
      )
      const get = Effect.fn("AlchemyConsole.catalogGet")(function*(id: StackId) {
        const entry = (yield* Ref.get(entries)).get(id)
        if (entry === undefined) return yield* new StackNotFound({})
        const state = yield* entry.read
        if (
          state.app !== entry.summary.app || state.stage !== entry.summary.stage ||
          state.backend !== entry.summary.backend
        ) return yield* new CatalogReadError({ reason: "invalid-source" })
        if (state.resources.length > 50_000) return yield* new CatalogReadError({ reason: "limit" })
        if (state.outputs !== null && state.outputs.length > 1000) {
          return yield* new CatalogReadError({ reason: "limit" })
        }
        const edgeCount = state.resources.reduce((count, resource) => count + (resource.downstream?.length ?? 0), 0)
        if (edgeCount > 100_000) return yield* new CatalogReadError({ reason: "limit" })
        return {
          id,
          state: {
            app: state.app,
            stage: state.stage,
            backend: state.backend,
            alchemyVersion: state.alchemyVersion,
            lastDeploy: state.lastDeploy,
            resources: state.resources.map(publicResource),
            outputs: state.outputs === null ? null : state.outputs.map((output): OutputSummary => ({
              key: output.key,
              value: { _tag: "Hidden" },
              description: null
            }))
          }
        }
      })
      const identify = Effect.fn("AlchemyConsole.catalogIdentify")(function*(id: StackId) {
        const entry = (yield* Ref.get(entries)).get(id)
        if (entry === undefined) return yield* new StackNotFound({})
        return entry.summary
      })
      return Catalog.of({ list: list(), get, identify })
    })
  )
}

/** Explicit projection prevents a private reader's extra fields from reaching a transport encoder. */
const publicResource = (resource: ResourceSummary): ResourceSummary => ({
  fqn: resource.fqn,
  logicalId: resource.logicalId,
  resourceType: resource.resourceType,
  status: resource.status,
  parent: resource.parent,
  providerId: resource.providerId,
  account: resource.account,
  region: resource.region,
  consoleUrl: resource.consoleUrl,
  updatedAt: resource.updatedAt,
  downstream: resource.downstream
})
