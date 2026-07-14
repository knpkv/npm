import * as NodeServices from "@effect/platform-node/NodeServices"
import { type Page, test as base } from "@playwright/test"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Path from "effect/Path"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { createServer } from "node:net"

import { BenchmarkInvariantError } from "../scripts/benchmarkErrors.js"
import {
  CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS,
  generateControlCenterBenchmarkFixture
} from "../scripts/benchmarkFixture.js"
import {
  controlCenterRuntimeBenchmarkOutputPath,
  type ControlCenterRuntimeBenchmarkReport,
  makeControlCenterRuntimeBenchmarkReport,
  type MakeControlCenterRuntimeBenchmarkReportInput,
  writeControlCenterRuntimeBenchmarkReport
} from "../scripts/benchmarkRuntimeReport.js"
import { DomainEventId, EntityId, ReleaseId } from "../src/domain/identifiers.js"
import { Release } from "../src/domain/release.js"
import { deriveReleaseRelay } from "../src/domain/releaseRelay.js"
import { SourceRevision } from "../src/domain/sourceRevision.js"
import { UtcTimestamp } from "../src/domain/utcTimestamp.js"
import {
  type ReleaseSynchronizationInput,
  synchronizeFakeReleaseFromMap
} from "../src/server/application/releaseSynchronization.js"
import { Persistence, persistenceLayer } from "../src/server/persistence/Persistence.js"
import { BlobRoot, LocalDatabaseUrl, type PersistenceConfig } from "../src/server/persistence/PersistenceConfig.js"
import { DomainEventDedupeKey } from "../src/server/persistence/repositories/domainEventModels.js"
import { PluginConnectionDisplayName, WorkspaceName } from "../src/server/persistence/repositories/models.js"
import { makeFakePluginRuntime } from "../src/server/plugins/fake/FakePluginDefinition.js"
import { PluginConnection } from "../src/server/plugins/PluginConnection.js"
import { PluginConnectionMap, type PluginConnectionMapV1 } from "../src/server/plugins/PluginConnectionMap.js"
import { ControlCenterBootstrap } from "../src/server/runtime/Bootstrap.js"
import { makeControlCenterServer } from "../src/server/runtime/ControlCenterServer.js"
import { ReleaseSynchronizationStartup } from "../src/server/runtime/ReleaseSynchronizationStartup.js"
import { SecretRoot } from "../src/server/secrets/SecretStore.js"
import { decodeBindConfig } from "../src/server/security/BindConfig.js"
import { disposeFailedFixtureSetup, protectPartialFixtureAllocation } from "./realRuntimeLifecycle.js"
import {
  REAL_FIXTURE_TIME_INPUT,
  REAL_OWNER_ID,
  REAL_PLUGIN_ID,
  REAL_RELEASE_ID,
  REAL_WORKSPACE_ID,
  realFakeDescriptor,
  realFakeScenario
} from "./realRuntimeScenario.js"

const SYNCHRONIZATION_INPUT = {
  workspaceId: REAL_WORKSPACE_ID,
  pluginConnectionId: REAL_PLUGIN_ID,
  streamKey: "releases"
} satisfies ReleaseSynchronizationInput

const acquireEphemeralPort = Effect.tryPromise({
  try: () =>
    new Promise<number>((resolve, reject) => {
      const probe = createServer()
      probe.once("error", reject)
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address()
        if (address === null || typeof address === "string") {
          probe.close()
          reject(new Error("ephemeral listener did not expose an internet port"))
          return
        }
        probe.close((error) => (error === undefined ? resolve(address.port) : reject(error)))
      })
    }),
  catch: (cause) => new Error("could not reserve an ephemeral browser-test port", { cause })
})

interface AllocatedFixture {
  readonly dataRoot: string
  readonly origin: string
  readonly persistenceConfig: PersistenceConfig
  readonly port: number
  readonly secretRoot: SecretRoot
  readonly staticRoot: string
}

const allocateFixture = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dataRoot = yield* fileSystem.makeTempDirectory({ prefix: "control-center-browser-runtime-" })
  return yield* protectPartialFixtureAllocation(
    Effect.gen(function*() {
      yield* fileSystem.chmod(dataRoot, 0o700)
      const port = yield* acquireEphemeralPort
      return {
        dataRoot,
        origin: `http://127.0.0.1:${port}`,
        persistenceConfig: {
          blobRoot: BlobRoot.make(path.join(dataRoot, "blobs")),
          busyTimeoutMilliseconds: 5_000,
          databaseUrl: LocalDatabaseUrl.make(`file:${path.join(dataRoot, "control-center.db")}`),
          maxConnections: 1
        },
        port,
        secretRoot: SecretRoot.make(path.join(dataRoot, "secrets")),
        staticRoot: yield* path.fromFileUrl(new URL("../dist/client/", import.meta.url))
      } satisfies AllocatedFixture
    }),
    fileSystem.remove(dataRoot, { force: true, recursive: true })
  )
}).pipe(Effect.provide(NodeServices.layer))

const seedFixture = (allocated: AllocatedFixture) =>
  Effect.gen(function*() {
    const fixtureTime = yield* Schema.decodeUnknownEffect(UtcTimestamp)(REAL_FIXTURE_TIME_INPUT)
    const persistence = yield* Persistence
    yield* persistence.workspaces.create(REAL_WORKSPACE_ID, {
      displayName: WorkspaceName.make("Real browser runtime"),
      createdAt: fixtureTime
    })
    yield* persistence.pluginConnections.create(REAL_WORKSPACE_ID, {
      pluginConnectionId: REAL_PLUGIN_ID,
      providerId: "jira",
      displayName: PluginConnectionDisplayName.make("Runtime Jira"),
      isEnabled: true,
      createdAt: fixtureTime
    })
    yield* persistence.pluginRuntime.acceptPluginDescriptor(
      REAL_WORKSPACE_ID,
      REAL_PLUGIN_ID,
      "jira",
      realFakeDescriptor,
      0,
      fixtureTime
    )
  }).pipe(
    Effect.provide(persistenceLayer(allocated.persistenceConfig)),
    Effect.provide(NodeServices.layer),
    Effect.scoped
  )

const removeDataRoot = (dataRoot: string): Promise<void> =>
  Effect.runPromise(
    Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.remove(dataRoot, { force: true, recursive: true }))
      .pipe(Effect.provide(NodeServices.layer))
  )

const disposeAll = async (
  serverRuntime: { readonly dispose: () => Promise<void> } | undefined,
  dataRoot: string
): Promise<void> => {
  const failures: Array<unknown> = []
  for (
    const dispose of [
      serverRuntime === undefined ? undefined : () => serverRuntime.dispose(),
      () => removeDataRoot(dataRoot)
    ]
  ) {
    if (dispose === undefined) continue
    try {
      await dispose()
    } catch (failure) {
      failures.push(failure)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "real runtime fixture teardown failed")
}

export interface RealRuntimeFixture {
  readonly dispose: () => Promise<void>
  readonly lifecycleEvidence: () => RealRuntimeLifecycleEvidence
  readonly origin: string
  readonly pairThroughUi: (page: Page) => Promise<void>
  readonly seedBenchmarkPersistence: () => Promise<RealRuntimePersistenceEvidence>
  readonly synchronizeUpdate: () => Promise<void>
  readonly writeBenchmarkReport: (
    input: MakeControlCenterRuntimeBenchmarkReportInput
  ) => Promise<{ readonly outputPath: string; readonly report: ControlCenterRuntimeBenchmarkReport }>
}

/** Observable resource counters owned by the managed browser-test server fixture. */
export interface RealRuntimeLifecycleEvidence {
  readonly activeManagedServers: number
  readonly disposedManagedServers: number
}

/** Actual durable cardinalities observed after seeding the large runtime benchmark. */
export interface RealRuntimePersistenceEvidence {
  readonly freshIngestionMilliseconds: number
  readonly generatedEdges: number
  readonly generatedFiles: number
  readonly persistedEntities: number
  readonly persistedEvents: number
  readonly persistedReleases: number
}

/** Start one real Control Center server whose resources remain owned until explicit fixture disposal. */
export const startRealRuntimeFixture = async (): Promise<RealRuntimeFixture> => {
  const allocated = await Effect.runPromise(allocateFixture)
  let serverRuntime: { readonly dispose: () => Promise<void> } | undefined
  try {
    await Effect.runPromise(seedFixture(allocated))
    const fakeRuntime = await Effect.runPromise(makeFakePluginRuntime(realFakeScenario))
    const pluginConnections: PluginConnectionMapV1 = {
      contextEffect: () =>
        Layer.build(fakeRuntime.layer).pipe(
          Effect.map((context) => Context.make(PluginConnection, Context.get(context, PluginConnection)))
        ),
      invalidate: () => Effect.void
    }
    const bindConfig = await Effect.runPromise(decodeBindConfig({ port: allocated.port }))
    const typedServerRuntime = ManagedRuntime.make(
      makeControlCenterServer({
        bindConfig,
        persistenceConfig: allocated.persistenceConfig,
        secretRoot: allocated.secretRoot,
        staticAssets: { root: allocated.staticRoot },
        bootstrap: {
          workspaceId: REAL_WORKSPACE_ID,
          workspaceName: WorkspaceName.make("Real browser runtime"),
          owner: { _tag: "human", personId: REAL_OWNER_ID }
        },
        releaseSynchronization: { input: SYNCHRONIZATION_INPUT, pluginConnections }
      }).pipe(Layer.provideMerge(NodeServices.layer))
    )
    serverRuntime = typedServerRuntime
    const context = await typedServerRuntime.context()
    const bootstrap = Context.get(context, ControlCenterBootstrap)
    const startup = Context.get(context, ReleaseSynchronizationStartup)
    if (bootstrap._tag !== "pairing-issued") throw new Error("real runtime did not issue its first pairing code")
    if (
      startup._tag !== "completed" ||
      startup.outcome._tag !== "synchronized" ||
      startup.outcome.releaseId !== REAL_RELEASE_ID
    ) {
      throw new Error("real runtime did not finish its startup release synchronization")
    }

    let disposed = false
    const lifecycleEvidence = { activeManagedServers: 1, disposedManagedServers: 0 }
    return {
      seedBenchmarkPersistence: async () => {
        const fixture = generateControlCenterBenchmarkFixture()
        const persistence = Context.get(context, Persistence)
        const fixtureTime = await typedServerRuntime.runPromise(
          Schema.decodeUnknownEffect(UtcTimestamp)(REAL_FIXTURE_TIME_INPUT)
        )
        return await typedServerRuntime.runPromise(
          Effect.gen(function*() {
            const startedAt = yield* Effect.clockWith((clock) => clock.currentTimeNanos)
            const before = yield* persistence.events.streamState(REAL_WORKSPACE_ID)
            if (before.headCursor > CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.timelineEvents) {
              return yield* new BenchmarkInvariantError({
                reason: "Benchmark journal already exceeds its target cardinality."
              })
            }
            yield* persistence.transact(
              Effect.gen(function*() {
                yield* Effect.forEach(
                  fixture.releases.slice(0, CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.releases - 1),
                  (benchmarkRelease) => {
                    const releaseId = ReleaseId.make(benchmarkRelease.id)
                    const release = Schema.decodeSync(Release)({
                      createdAt: REAL_FIXTURE_TIME_INPUT,
                      freshness: {
                        _tag: "unavailable",
                        pluginHealth: { _tag: "disabled", checkedAt: REAL_FIXTURE_TIME_INPUT },
                        provenance: { _tag: "none", pluginConnectionId: REAL_PLUGIN_ID },
                        sourceObservedAt: null,
                        staleAfterSeconds: 300,
                        synchronizedAt: null
                      },
                      id: releaseId,
                      lifecycle: "candidate",
                      relay: deriveReleaseRelay(releaseId),
                      roleAssignments: [],
                      serviceName: benchmarkRelease.serviceName,
                      sourceRevisions: [],
                      targetEnvironmentIds: [],
                      updatedAt: REAL_FIXTURE_TIME_INPUT,
                      version: benchmarkRelease.version,
                      workspaceId: REAL_WORKSPACE_ID
                    })
                    return persistence.releases.create(REAL_WORKSPACE_ID, release)
                  },
                  { concurrency: 1, discard: true }
                )
                yield* Effect.forEach(
                  fixture.entities,
                  (benchmarkEntity) => {
                    const entityId = EntityId.make(
                      `01890f6f-6d6a-7cc0-98d2-${String(benchmarkEntity.ordinal + 200_000).padStart(12, "0")}`
                    )
                    const sourceRevision = Schema.decodeSync(SourceRevision)({
                      firstObservedAt: REAL_FIXTURE_TIME_INPUT,
                      lastObservedAt: REAL_FIXTURE_TIME_INPUT,
                      normalizationSchemaVersion: 1,
                      pluginConnectionId: REAL_PLUGIN_ID,
                      providerId: "jira",
                      revision: `benchmark-entity-${benchmarkEntity.ordinal}`,
                      sourceUrl: null,
                      synchronizedAt: REAL_FIXTURE_TIME_INPUT,
                      vendorImmutableId: benchmarkEntity.id
                    })
                    return persistence.entities.create(REAL_WORKSPACE_ID, {
                      createdAt: fixtureTime,
                      entityId,
                      entityType: benchmarkEntity.kind,
                      sourceRevision
                    })
                  },
                  { concurrency: 1, discard: true }
                )
                yield* Effect.forEach(
                  Array.from(
                    { length: CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.timelineEvents - before.headCursor },
                    (_, index) => before.headCursor + index + 1
                  ),
                  (ordinal) =>
                    persistence.events.append(REAL_WORKSPACE_ID, {
                      causationId: null,
                      correlationId: null,
                      dedupeKey: DomainEventDedupeKey.make(`browser-benchmark-${ordinal}`),
                      eventId: DomainEventId.make(
                        `01890f6f-6d6a-7cc0-98d2-${String(ordinal + 100_000).padStart(12, "0")}`
                      ),
                      eventType: "portfolio-invalidated",
                      metadata: {},
                      occurredAt: fixtureTime,
                      payload: { reason: "release-projection" },
                      schemaVersion: 1
                    }),
                  { concurrency: 1, discard: true }
                )
              })
            )
            const releases = yield* persistence.releases.list(
              REAL_WORKSPACE_ID,
              CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.releases
            )
            const entities = yield* persistence.entities.list(REAL_WORKSPACE_ID)
            const events = yield* persistence.events.streamState(REAL_WORKSPACE_ID)
            const completedAt = yield* Effect.clockWith((clock) => clock.currentTimeNanos)
            return {
              freshIngestionMilliseconds: Number(completedAt - startedAt) / 1_000_000,
              generatedEdges: fixture.edges.length,
              generatedFiles: fixture.files.length,
              persistedEntities: entities.length,
              persistedEvents: events.headCursor,
              persistedReleases: releases.length
            }
          })
        )
      },
      dispose: async () => {
        if (disposed) return
        disposed = true
        await disposeAll(typedServerRuntime, allocated.dataRoot)
        lifecycleEvidence.activeManagedServers = 0
        lifecycleEvidence.disposedManagedServers += 1
      },
      lifecycleEvidence: () => ({ ...lifecycleEvidence }),
      origin: allocated.origin,
      pairThroughUi: async (page) => {
        await page.goto(`${allocated.origin}/pair`)
        await page.getByLabel("Pairing code").fill(Redacted.value(bootstrap.pairingCode))
        await page.getByRole("button", { name: "Pair browser" }).click()
      },
      synchronizeUpdate: async () => {
        const outcome = await typedServerRuntime.runPromise(
          synchronizeFakeReleaseFromMap(SYNCHRONIZATION_INPUT).pipe(
            Effect.provideService(PluginConnectionMap, pluginConnections)
          )
        )
        if (outcome._tag !== "synchronized" || outcome.releaseId !== REAL_RELEASE_ID) {
          throw new Error("real runtime did not apply its incremental release synchronization")
        }
      },
      writeBenchmarkReport: async (input) =>
        await Effect.runPromise(
          Effect.gen(function*() {
            const report = yield* makeControlCenterRuntimeBenchmarkReport(input)
            const outputPath = yield* controlCenterRuntimeBenchmarkOutputPath
            yield* writeControlCenterRuntimeBenchmarkReport(report, outputPath)
            return { outputPath, report }
          }).pipe(Effect.provide(NodeServices.layer))
        )
    }
  } catch (failure) {
    return await disposeFailedFixtureSetup(failure, () => disposeAll(serverRuntime, allocated.dataRoot))
  }
}

interface RealRuntimeWorkerFixtures {
  readonly realRuntime: RealRuntimeFixture
}

/** Own the real server for one worker and release it after Playwright closes that worker's browser contexts. */
export const test = base.extend<Record<never, never>, RealRuntimeWorkerFixtures>({
  realRuntime: [
    async ({ browserName: _browserName }, use) => {
      const fixture = await startRealRuntimeFixture()
      try {
        await use(fixture)
      } finally {
        await fixture.dispose()
      }
    },
    { scope: "worker" }
  ]
})
