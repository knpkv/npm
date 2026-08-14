import * as NodeServices from "@effect/platform-node/NodeServices"
import { type Page, test as base } from "@playwright/test"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Agent as HttpAgent, request as httpRequest } from "node:http"
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https"
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
import { Auth } from "../src/server/auth/Auth.js"
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
import { forwardedProxyHeaders } from "./trustedHttpsProxyHeaders.js"

const SYNCHRONIZATION_INPUT = {
  workspaceId: REAL_WORKSPACE_ID,
  pluginConnectionId: REAL_PLUGIN_ID,
  streamKey: "releases"
} satisfies ReleaseSynchronizationInput

const TRUSTED_PROXY_TEST_CLIENT_HEADER = "x-control-center-test-proxy-client"

class EphemeralPortFixtureError extends Schema.TaggedError<EphemeralPortFixtureError>()(
  "EphemeralPortFixtureError",
  { message: Schema.String }
) {}

const trustedProxyForwardedClient = (selector: string | ReadonlyArray<string> | undefined): string => {
  if (selector === "rate-limit-a") return "192.168.1.26"
  if (selector === "rate-limit-b") return "192.168.1.27"
  return "192.168.1.25"
}

const acquireEphemeralPort = Effect.tryPromise({
  try: () =>
    new Promise<number>((resolve, reject) => {
      const probe = createServer()
      probe.once("error", reject)
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address()
        if (address === null || Predicate.isString(address)) {
          probe.close()
          reject(new Error("ephemeral listener did not expose an internet port"))
          return
        }
        probe.close((error) => (error === undefined ? resolve(address.port) : reject(error)))
      })
    }),
  catch: () =>
    new EphemeralPortFixtureError({
      message: "could not reserve an ephemeral browser-test port"
    })
})

interface AllocatedFixture {
  readonly dataRoot: string
  readonly origin: string
  readonly persistenceConfig: PersistenceConfig
  readonly port: number
  readonly secretRoot: SecretRoot
  readonly staticRoot: string
  readonly trustedHttpsProxyPort: number | null
  readonly upstreamOrigin: string
}

export interface StartRealRuntimeFixtureOptions {
  readonly trustedHttpsProxy?: boolean
}

const allocateFixture = (options: StartRealRuntimeFixtureOptions) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dataRoot = yield* fileSystem.makeTempDirectory({ prefix: "control-center-browser-runtime-" })
    return yield* protectPartialFixtureAllocation(
      Effect.gen(function*() {
        yield* fileSystem.chmod(dataRoot, 0o700)
        const port = yield* acquireEphemeralPort
        const trustedHttpsProxyPort = options.trustedHttpsProxy === true ? yield* acquireEphemeralPort : null
        const upstreamOrigin = `http://127.0.0.1:${port}`
        return {
          dataRoot,
          origin: trustedHttpsProxyPort === null ? upstreamOrigin : `https://127.0.0.1:${trustedHttpsProxyPort}`,
          persistenceConfig: {
            blobRoot: BlobRoot.make(path.join(dataRoot, "blobs")),
            busyTimeoutMilliseconds: 5_000,
            databaseUrl: LocalDatabaseUrl.make(`file:${path.join(dataRoot, "control-center.db")}`),
            maxConnections: 1
          },
          port,
          secretRoot: SecretRoot.make(path.join(dataRoot, "secrets")),
          staticRoot: yield* path.fromFileUrl(new URL("../dist/client/", import.meta.url)),
          trustedHttpsProxyPort,
          upstreamOrigin
        } satisfies AllocatedFixture
      }),
      fileSystem.remove(dataRoot, { force: true, recursive: true })
    )
  }).pipe(Effect.provide(NodeServices.layer))

class TrustedHttpsProxyFixtureError extends Schema.TaggedError<TrustedHttpsProxyFixtureError>()(
  "TrustedHttpsProxyFixtureError",
  { reason: Schema.String }
) {}

interface TrustedHttpsProxy {
  readonly agent: HttpAgent
  readonly failure: () => TrustedHttpsProxyFixtureError | null
  readonly server: HttpsServer
}

const shortFailureDescription = <UnparsedInput>(failure: UnparsedInput): string =>
  Predicate.isError(failure) && failure.message.length > 0 ? failure.message : String(failure)

const closeHttpsProxy = async (proxy: TrustedHttpsProxy): Promise<void> => {
  try {
    await new Promise<void>((resolve, reject) => {
      proxy.server.close((error) => (error === undefined ? resolve() : reject(error)))
      proxy.server.closeAllConnections()
    })
  } finally {
    proxy.agent.destroy()
  }
  const failure = proxy.failure()
  if (failure !== null) throw failure
}

const startTrustedHttpsProxy = Effect.fn("controlCenter.startTrustedHttpsProxy")(function*(
  allocated: AllocatedFixture
) {
  if (allocated.trustedHttpsProxyPort === null) {
    return yield* new TrustedHttpsProxyFixtureError({ reason: "trusted HTTPS proxy port was not allocated" })
  }
  const trustedHttpsProxyPort = allocated.trustedHttpsProxyPort
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const certificatePath = path.join(allocated.dataRoot, "trusted-proxy-certificate.pem")
  const privateKeyPath = path.join(allocated.dataRoot, "trusted-proxy-private-key.pem")
  const exitCode = yield* spawner
    .exitCode(
      ChildProcess.make(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          privateKeyPath,
          "-out",
          certificatePath,
          "-subj",
          "/CN=127.0.0.1",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
          "-days",
          "1"
        ],
        { stderr: "ignore", stdout: "ignore" }
      )
    )
    .pipe(
      Effect.mapError(() => new TrustedHttpsProxyFixtureError({ reason: "could not generate the test TLS identity" }))
    )
  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new TrustedHttpsProxyFixtureError({ reason: "test TLS identity generation failed" })
  }
  const certificate = yield* fileSystem
    .readFile(certificatePath)
    .pipe(
      Effect.mapError(() => new TrustedHttpsProxyFixtureError({ reason: "could not read the test TLS certificate" }))
    )
  const privateKey = yield* fileSystem
    .readFile(privateKeyPath)
    .pipe(
      Effect.mapError(() => new TrustedHttpsProxyFixtureError({ reason: "could not read the test TLS private key" }))
    )
  const publicOrigin = new URL(allocated.origin)
  const upstreamOrigin = new URL(allocated.upstreamOrigin)

  return yield* Effect.tryPromise({
    try: () =>
      new Promise<TrustedHttpsProxy>((resolve, reject) => {
        let runtimeFailure: TrustedHttpsProxyFixtureError | null = null
        let started = false
        const agent = new HttpAgent({ keepAlive: true, maxSockets: 32 })
        const server = createHttpsServer(
          {
            cert: Buffer.from(certificate),
            key: Buffer.from(privateKey)
          },
          (request, response) => {
            let downstreamAborted = false
            const upstreamHeaders = forwardedProxyHeaders(request.headers)
            delete upstreamHeaders[TRUSTED_PROXY_TEST_CLIENT_HEADER]
            const proxyRequest = httpRequest(
              {
                agent,
                headers: {
                  ...upstreamHeaders,
                  host: publicOrigin.host,
                  "x-forwarded-for": trustedProxyForwardedClient(
                    request.headers[TRUSTED_PROXY_TEST_CLIENT_HEADER]
                  ),
                  "x-forwarded-host": publicOrigin.host,
                  "x-forwarded-proto": "https"
                },
                hostname: upstreamOrigin.hostname,
                method: request.method,
                path: request.url,
                port: upstreamOrigin.port
              },
              (proxyResponse) => {
                response.writeHead(
                  proxyResponse.statusCode ?? 502,
                  forwardedProxyHeaders(proxyResponse.headers)
                )
                proxyResponse.pipe(response)
              }
            )
            proxyRequest.once("error", (cause) => {
              if (!downstreamAborted) {
                runtimeFailure = new TrustedHttpsProxyFixtureError({
                  reason: `test HTTPS proxy upstream request failed: ${shortFailureDescription(cause)}`
                })
              }
              if (!response.headersSent) response.writeHead(502)
              response.end()
            })
            request.once("aborted", () => {
              downstreamAborted = true
              proxyRequest.destroy()
            })
            response.once("close", () => {
              if (response.writableEnded) return
              downstreamAborted = true
              proxyRequest.destroy()
            })
            request.pipe(proxyRequest)
          }
        )
        server.on("error", (cause) => {
          const failure = new TrustedHttpsProxyFixtureError({
            reason: `test HTTPS proxy failed: ${shortFailureDescription(cause)}`
          })
          if (!started) {
            agent.destroy()
            reject(failure)
            return
          }
          runtimeFailure = failure
        })
        server.listen(trustedHttpsProxyPort, "127.0.0.1", () => {
          started = true
          resolve({ agent, failure: () => runtimeFailure, server })
        })
      }),
    catch: (cause) =>
      new TrustedHttpsProxyFixtureError({
        reason: `could not start the test HTTPS proxy: ${shortFailureDescription(cause)}`
      })
  })
})

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
    Effect.provide(
      persistenceLayer(allocated.persistenceConfig).pipe(Layer.provideMerge(NodeServices.layer))
    ),
    Effect.scoped
  )

const removeDataRoot = (dataRoot: string): Promise<void> =>
  Effect.runPromise(
    Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.remove(dataRoot, { force: true, recursive: true }))
      .pipe(Effect.provide(NodeServices.layer))
  )

const disposeAll = async (
  trustedHttpsProxy: TrustedHttpsProxy | undefined,
  serverRuntime: { readonly dispose: () => Promise<void> } | undefined,
  dataRoot: string
): Promise<void> => {
  const failures: Array<unknown> = []
  for (
    const dispose of [
      trustedHttpsProxy === undefined ? undefined : () => closeHttpsProxy(trustedHttpsProxy),
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
  readonly applicationLogForbiddenValues: () => ReadonlyArray<{
    readonly label: string
    readonly value: string
  }>
  readonly applicationLogEntries: () => ReadonlyArray<string>
  readonly dispose: () => Promise<void>
  readonly emitApplicationLogFixture: (message: string) => Promise<void>
  readonly lifecycleEvidence: () => RealRuntimeLifecycleEvidence
  readonly origin: string
  readonly pairThroughUi: (page: Page) => Promise<{ readonly consumedPairingCode: string }>
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

/** Fail closed when the bounded release read observes either missing or surplus durable heads. */
export const validateBenchmarkReleaseCardinality = Effect.fn(
  "controlCenter.validateBenchmarkReleaseCardinality"
)(function*(persistedReleases: number) {
  if (persistedReleases !== CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.releases) {
    return yield* new BenchmarkInvariantError({
      reason: "Benchmark releases do not match the exact target cardinality."
    })
  }
  return persistedReleases
})

/** Start one real Control Center server whose resources remain owned until explicit fixture disposal. */
export const startRealRuntimeFixture = async (
  options: StartRealRuntimeFixtureOptions = {}
): Promise<RealRuntimeFixture> => {
  const allocated = await Effect.runPromise(allocateFixture(options))
  let serverRuntime: { readonly dispose: () => Promise<void> } | undefined
  let trustedHttpsProxy: TrustedHttpsProxy | undefined
  try {
    await Effect.runPromise(seedFixture(allocated))
    const applicationLogEntries: Array<string> = []
    const applicationLogCapture = Logger.make<unknown, void>((options) => {
      applicationLogEntries.push(Logger.formatJson.log(options))
    })
    const fakeRuntime = await Effect.runPromise(makeFakePluginRuntime(realFakeScenario))
    const pluginConnections: PluginConnectionMapV1 = {
      contextEffect: () =>
        Layer.build(fakeRuntime.layer).pipe(
          Effect.map((context) => Context.make(PluginConnection, Context.get(context, PluginConnection)))
        ),
      invalidate: () => Effect.void
    }
    const bindConfig = await Effect.runPromise(
      decodeBindConfig(
        allocated.trustedHttpsProxyPort === null
          ? { port: allocated.port }
          : {
            allowedHosts: [new URL(allocated.origin).host],
            allowedOrigins: [allocated.origin],
            port: allocated.port,
            publicOrigin: allocated.origin,
            trustedProxyAddresses: ["127.0.0.1"]
          }
      )
    )
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
      }).pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Logger.layer([applicationLogCapture]))
      )
    )
    serverRuntime = typedServerRuntime
    const context = await typedServerRuntime.context()
    const auth = Context.get(context, Auth)
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
    const ownerSessionToken = (await typedServerRuntime.runPromise(auth.consumePairingCode(bootstrap.pairingCode)))
      .sessionToken
    const applicationLogForbiddenValues = [
      { label: "bootstrap pairing code", value: Redacted.value(bootstrap.pairingCode) },
      { label: "bootstrap owner session token", value: Redacted.value(ownerSessionToken) }
    ]
    if (allocated.trustedHttpsProxyPort !== null) {
      trustedHttpsProxy = await Effect.runPromise(
        startTrustedHttpsProxy(allocated).pipe(Effect.provide(NodeServices.layer))
      )
    }

    let disposed = false
    const lifecycleEvidence = { activeManagedServers: 1, disposedManagedServers: 0 }
    return {
      applicationLogForbiddenValues: () => [...applicationLogForbiddenValues],
      applicationLogEntries: () => [...applicationLogEntries],
      emitApplicationLogFixture: async (message) => {
        await typedServerRuntime.runPromise(Effect.logInfo(message))
      },
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
              CONTROL_CENTER_BENCHMARK_FIXTURE_COUNTS.releases + 1
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
              persistedReleases: yield* validateBenchmarkReleaseCardinality(releases.length)
            }
          })
        )
      },
      dispose: async () => {
        if (disposed) return
        disposed = true
        await disposeAll(trustedHttpsProxy, typedServerRuntime, allocated.dataRoot)
        lifecycleEvidence.activeManagedServers = 0
        lifecycleEvidence.disposedManagedServers += 1
      },
      lifecycleEvidence: () => ({ ...lifecycleEvidence }),
      origin: allocated.origin,
      pairThroughUi: async (page) => {
        const pairing = await typedServerRuntime.runPromise(
          auth.issuePairingCode(ownerSessionToken, {
            actor: { _tag: "human", personId: REAL_OWNER_ID },
            permission: "workspace-owner"
          })
        )
        const consumedPairingCode = Redacted.value(pairing.pairingCode)
        await page.goto(`${allocated.origin}/pair`)
        await page.getByLabel("Pairing code").fill(consumedPairingCode)
        await page.getByRole("button", { name: "Pair browser" }).click()
        return { consumedPairingCode }
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
    return await disposeFailedFixtureSetup(
      failure,
      () => disposeAll(trustedHttpsProxy, serverRuntime, allocated.dataRoot)
    )
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
