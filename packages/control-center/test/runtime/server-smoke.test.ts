import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { createServer } from "node:net"

import { makeControlCenterApiClient } from "../../src/api/client.js"
import { PairingCode } from "../../src/api/session.js"
import { PluginHealth } from "../../src/domain/freshness.js"
import {
  EnvironmentId,
  GovernedActionId,
  PersonId,
  PluginConnectionId,
  ReleaseId,
  RoleAssignmentId,
  WorkspaceId
} from "../../src/domain/identifiers.js"
import { PluginSyncPageV1 } from "../../src/domain/plugins/events.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { databaseLayer } from "../../src/server/persistence/Database.js"
import { Persistence, persistenceLayer } from "../../src/server/persistence/Persistence.js"
import { BlobRoot, LocalDatabaseUrl, type PersistenceConfig } from "../../src/server/persistence/PersistenceConfig.js"
import { DeliveryGraphRepository } from "../../src/server/persistence/repositories/deliveryGraphRepository.js"
import { GovernedActionRepository } from "../../src/server/persistence/repositories/governedActionRepository.js"
import { PluginConnectionDisplayName, WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { PluginStreamKey } from "../../src/server/persistence/repositories/pluginRuntimeModels.js"
import { PluginRuntimeRepository } from "../../src/server/persistence/repositories/pluginRuntimeRepository.js"
import { QuarantineRepository } from "../../src/server/persistence/repositories/quarantineRepository.js"
import { makeFakePluginRuntime } from "../../src/server/plugins/fake/FakePluginDefinition.js"
import { type FakePluginScenario, fakeSyncScriptKey } from "../../src/server/plugins/fake/FakePluginScenario.js"
import {
  PluginRuntimeAccountDigest,
  PluginRuntimeAuthority,
  PluginRuntimeSourceDigest
} from "../../src/server/plugins/internal/PluginRuntimeAuthority.js"
import { pluginRuntimeAuthoritySourceLayer } from "../../src/server/plugins/internal/PluginRuntimeAuthorityRepository.js"
import { PluginRuntimeAuthoritySource } from "../../src/server/plugins/internal/PluginRuntimeAuthoritySource.js"
import { PluginConnection } from "../../src/server/plugins/PluginConnection.js"
import type { PluginConnectionMapV1 } from "../../src/server/plugins/PluginConnectionMap.js"
import { ControlCenterBootstrap } from "../../src/server/runtime/Bootstrap.js"
import { makeControlCenterServer } from "../../src/server/runtime/ControlCenterServer.js"
import {
  GovernedActionExecutionStartup,
  governedActionExecutionStartupLayer
} from "../../src/server/runtime/GovernedActionExecutionStartup.js"
import { ReleaseSynchronizationStartup } from "../../src/server/runtime/ReleaseSynchronizationStartup.js"
import { ServerLifecycle } from "../../src/server/runtime/ServerLifecycle.js"
import { SecretRoot } from "../../src/server/secrets/SecretStore.js"
import { decodeBindConfig } from "../../src/server/security/BindConfig.js"
import {
  ACTION_ID as AUTHORIZED_ACTION_ID,
  CONNECTION_ID as AUTHORIZED_CONNECTION_ID,
  seedGovernedAction,
  seedGovernedActionAuthorityRoots,
  seedGovernedActionCurrentInputs,
  WORKSPACE_ID as AUTHORIZED_WORKSPACE_ID
} from "../governance/fixtures/authorizedGovernedAction.js"

const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000071")
const MISSING_ACTION_ID = GovernedActionId.make("01890f6f-6d6a-7cc0-98d2-000000000079")
const OWNER_ID = PersonId.make("01890f6f-6d6a-7cc0-98d2-000000000072")
const PLUGIN_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000073")
const RELEASE_ID = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000074")
const APPROVER_ID = PersonId.make("01890f6f-6d6a-7cc0-98d2-000000000075")
const ENVIRONMENT_ID = EnvironmentId.make("01890f6f-6d6a-7cc0-98d2-000000000076")
const OWNER_ASSIGNMENT_ID = RoleAssignmentId.make("01890f6f-6d6a-7cc0-98d2-000000000077")
const APPROVER_ASSIGNMENT_ID = RoleAssignmentId.make("01890f6f-6d6a-7cc0-98d2-000000000078")
const RELEASE_STREAM = PluginStreamKey.make("releases")
const PUBLIC_SERVER_EXCLUDES_EXECUTION_CAPABILITY: Extract<
  Layer.Success<ReturnType<typeof makeControlCenterServer>>,
  GovernedActionExecutionStartup
> extends never ? true : false = true
const FIXTURE_TIME_INPUT = "2024-07-14T09:02:00.000Z"
const FIXTURE_TIME = Schema.decodeSync(UtcTimestamp)(FIXTURE_TIME_INPUT)
const GOVERNED_SOURCE_TIME = Schema.decodeSync(UtcTimestamp)("2026-07-15T10:00:00.000Z")
const GOVERNED_AUTHORITY_TIME = Schema.decodeSync(UtcTimestamp)("2026-07-15T10:01:00.000Z")
const GOVERNED_FIXTURE_TIME = Schema.decodeSync(UtcTimestamp)("2026-07-15T10:02:00.000Z")
const AUTHORIZED_WORKSPACE = Schema.decodeSync(WorkspaceId)(AUTHORIZED_WORKSPACE_ID)
const AUTHORIZED_CONNECTION = Schema.decodeSync(PluginConnectionId)(AUTHORIZED_CONNECTION_ID)
const AUTHORIZED_ACTION = Schema.decodeSync(GovernedActionId)(AUTHORIZED_ACTION_ID)

const fakeDescriptor = {
  contractId: "dev.knpkv.control-center.plugin",
  contractVersion: { major: 1, minor: 0, patch: 0 },
  pluginId: "dev.knpkv.fake-jira",
  adapterVersion: { major: 0, minor: 1, patch: 0 },
  displayName: "Deterministic Jira",
  configurationFields: [],
  capabilities: [{ capabilityId: "sync.incremental", supportedVersions: [1], requirement: "required" }]
}

const governedDescriptor = {
  contractId: "dev.knpkv.control-center.plugin",
  contractVersion: { major: 1, minor: 0, patch: 0 },
  pluginId: "dev.knpkv.jira",
  adapterVersion: { major: 1, minor: 2, patch: 3 },
  displayName: "Governed Jira",
  configurationFields: [],
  capabilities: [
    { capabilityId: "action.execute", supportedVersions: [1], requirement: "required" },
    { capabilityId: "action.reconcile", supportedVersions: [1], requirement: "required" }
  ]
}

const fakeReleasePage = {
  checkpointAfterPage: "checkpoint-1",
  hasMore: false,
  events: [{
    _tag: "UpsertEntity",
    eventId: "release-event-1",
    observedAt: "2024-07-14T09:01:00.000Z",
    revision: "release-r1",
    entityType: "release",
    vendorImmutableId: "provider-release-42",
    sourceUrl: "https://jira.example/releases/42",
    title: "Payments 2.18.0",
    attributes: {
      releaseId: RELEASE_ID,
      serviceName: "payments-api",
      version: "2.18.0-rc.1",
      lifecycle: "candidate",
      targetEnvironmentIds: [ENVIRONMENT_ID],
      staleAfterSeconds: 300,
      collaborators: [
        { personId: OWNER_ID, assignmentId: OWNER_ASSIGNMENT_ID, vendorPersonId: "ada", role: "release-owner" },
        {
          personId: APPROVER_ID,
          assignmentId: APPROVER_ASSIGNMENT_ID,
          vendorPersonId: "grace",
          role: "release-approver"
        }
      ]
    }
  }, {
    _tag: "UpsertPerson",
    eventId: "person-1",
    observedAt: "2024-07-14T09:01:00.000Z",
    revision: "person-r1",
    vendorPersonId: "ada",
    displayName: "Ada Lovelace",
    avatarUrl: null,
    active: true
  }, {
    _tag: "UpsertPerson",
    eventId: "person-2",
    observedAt: "2024-07-14T09:01:00.000Z",
    revision: "person-r1",
    vendorPersonId: "grace",
    displayName: "Grace Hopper",
    avatarUrl: null,
    active: true
  }]
}

const fakeScenario: FakePluginScenario = {
  descriptor: fakeDescriptor,
  discover: { _tag: "outage" },
  health: { _tag: "success", value: { _tag: "healthy", checkedAt: "2024-07-14T09:02:00.000Z" } },
  sync: {
    [fakeSyncScriptKey("releases", null)]: [{
      _tag: "success",
      value: fakeReleasePage
    }]
  },
  readEntity: { _tag: "outage" },
  proposeAction: { _tag: "outage" },
  preflight: { _tag: "outage" },
  executeAuthorizedAction: { _tag: "outage" },
  requestCancellation: { _tag: "outage" },
  reconcile: {}
}

const governedScenario: FakePluginScenario = {
  ...fakeScenario,
  descriptor: governedDescriptor,
  preflight: {
    _tag: "success",
    value: { _tag: "ready", checkedRevision: "1", checkedAt: "2026-07-15T10:02:00.000Z" }
  },
  executeAuthorizedAction: {
    _tag: "success",
    value: {
      _tag: "confirmed",
      receipt: {
        providerOperationId: "provider-operation-runtime-smoke",
        status: "succeeded",
        safeSummary: "Runtime smoke action completed",
        observedAt: "2026-07-15T10:02:00.000Z"
      }
    }
  }
}

const makeFakeConnectionMap = Effect.gen(function*() {
  const runtime = yield* makeFakePluginRuntime(fakeScenario)
  const runtimeContext = yield* Layer.build(runtime.layer)
  const connectionContext = Context.make(PluginConnection, Context.get(runtimeContext, PluginConnection))
  return {
    contextEffect: (_scope) => Effect.succeed(connectionContext),
    invalidate: () => Effect.void
  } satisfies PluginConnectionMapV1
})

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
        probe.close((error) => error === undefined ? resolve(address.port) : reject(error))
      })
    }),
  catch: (cause) => new Error("could not reserve an ephemeral test port", { cause })
})

const makeStaticFixture = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-runtime-static-" })
  yield* fileSystem.makeDirectory(path.join(root, ".vite"))
  yield* fileSystem.makeDirectory(path.join(root, "assets"))
  yield* fileSystem.writeFileString(path.join(root, "index.html"), "<main>Runtime fixture</main>")
  yield* fileSystem.writeFileString(path.join(root, "assets", "app.js"), "export const ready = true")
  yield* fileSystem.writeFileString(
    path.join(root, ".vite", "manifest.json"),
    JSON.stringify({ "src/client/main.tsx": { file: "assets/app.js", isEntry: true } })
  )
  return root
})

const seedAuthorizedRuntimeAction = Effect.fn("ControlCenterServerSmoke.seedAuthorizedRuntimeAction")(function*(
  persistenceConfig: PersistenceConfig
) {
  const database = databaseLayer(persistenceConfig)
  const foundation = QuarantineRepository.layer.pipe(Layer.provideMerge(database))
  const actions = GovernedActionRepository.layer.pipe(Layer.provide(foundation))
  const graph = DeliveryGraphRepository.layer.pipe(Layer.provide(foundation))
  const runtimes = PluginRuntimeRepository.layer.pipe(Layer.provide(foundation))
  const authorities = pluginRuntimeAuthoritySourceLayer.pipe(Layer.provide(foundation))
  const services = Layer.mergeAll(foundation, actions, graph, runtimes, authorities)

  return yield* Effect.gen(function*() {
    yield* seedGovernedActionAuthorityRoots()
    const runtimeRepository = yield* PluginRuntimeRepository
    const runtimeRecord = yield* runtimeRepository.acceptPluginDescriptor(
      AUTHORIZED_WORKSPACE,
      AUTHORIZED_CONNECTION,
      "jira",
      governedDescriptor,
      0,
      GOVERNED_SOURCE_TIME
    )
    const authoritySource = yield* PluginRuntimeAuthoritySource
    const current = yield* authoritySource.publish({
      scope: {
        workspaceId: AUTHORIZED_WORKSPACE,
        pluginConnectionId: AUTHORIZED_CONNECTION
      },
      expected: {
        providerId: "jira",
        connectionRevision: 1,
        descriptorGeneration: runtimeRecord.descriptorGeneration,
        configuration: { _tag: "absent" },
        descriptorDigest: PluginRuntimeSourceDigest.make(runtimeRecord.descriptorDigest)
      },
      accountDigest: PluginRuntimeAccountDigest.make(`sha256:${"c".repeat(64)}`),
      activatedAt: GOVERNED_AUTHORITY_TIME
    })
    yield* seedGovernedAction({
      pluginConnectionAuthorityDigest: current.runtimeAuthorityToken,
      seedAuthorityRoots: false
    })
    yield* seedGovernedActionCurrentInputs()
    return current
  }).pipe(Effect.provide(services))
})

describe("Control Center closed runtime", () => {
  it.effect("serves immutable SPA bytes and generated-client pairing plus portfolio", () =>
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const staticRoot = yield* makeStaticFixture
      const dataRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-runtime-data-" })
      yield* fileSystem.chmod(dataRoot, 0o700)
      const port = yield* acquireEphemeralPort
      const origin = `http://127.0.0.1:${port}`
      const bindConfig = yield* decodeBindConfig({ port })
      const persistenceConfig: PersistenceConfig = {
        blobRoot: BlobRoot.make(path.join(dataRoot, "blobs")),
        busyTimeoutMilliseconds: 5_000,
        databaseUrl: LocalDatabaseUrl.make(`file:${path.join(dataRoot, "control-center.db")}`),
        maxConnections: 1
      }
      const runtime = yield* Layer.build(makeControlCenterServer({
        bindConfig,
        persistenceConfig,
        secretRoot: SecretRoot.make(path.join(dataRoot, "secrets")),
        staticAssets: { root: staticRoot },
        bootstrap: {
          workspaceId: WORKSPACE_ID,
          workspaceName: WorkspaceName.make("Runtime smoke"),
          owner: { _tag: "human", personId: OWNER_ID }
        }
      }))
      const bootstrapState = Context.get(runtime, ControlCenterBootstrap)
      const governedExecution = Context.getOption(runtime, GovernedActionExecutionStartup)
      assert.strictEqual(bootstrapState._tag, "pairing-issued")
      assert.isTrue(PUBLIC_SERVER_EXCLUDES_EXECUTION_CAPABILITY)
      assert.isTrue(Option.isNone(governedExecution))
      if (bootstrapState._tag !== "pairing-issued") return

      const httpClient = yield* HttpClient.HttpClient
      const documentResponse = yield* httpClient.get(origin, {
        headers: { accept: "text/html" }
      })
      assert.strictEqual(
        yield* documentResponse.text,
        "<main>Runtime fixture</main>"
      )

      const requestHeaders = (client: HttpClient.HttpClient, headers: Readonly<Record<string, string>>) =>
        client.pipe(HttpClient.mapRequest(HttpClientRequest.setHeaders(headers)))
      const pairClient = yield* makeControlCenterApiClient({
        baseUrl: origin,
        transformClient: (client) => requestHeaders(client, { origin })
      })
      const [paired, pairResponse] = yield* pairClient.session.pair({
        payload: { pairingCode: PairingCode.make(Redacted.value(bootstrapState.pairingCode)) },
        responseMode: "decoded-and-response"
      })
      const sessionCookie = pairResponse.cookies.cookies.cc_session
      assert.isDefined(sessionCookie)
      if (sessionCookie === undefined) return

      const authenticatedClient = yield* makeControlCenterApiClient({
        baseUrl: origin,
        transformClient: (client) =>
          requestHeaders(client, {
            cookie: `cc_session=${sessionCookie.valueEncoded}`,
            origin
          })
      })
      const portfolio = yield* authenticatedClient.portfolio.snapshot()

      assert.strictEqual(paired.session.workspaceId, WORKSPACE_ID)
      assert.strictEqual(portfolio.workspaceId, WORKSPACE_ID)
      assert.deepStrictEqual(portfolio.releases, [])
      assert.deepStrictEqual(portfolio.plugins, [])

      const lifecycle = Context.get(runtime, ServerLifecycle)
      yield* lifecycle.beginDrain
      const mutationClient = yield* makeControlCenterApiClient({
        baseUrl: origin,
        transformClient: (client) =>
          requestHeaders(client, {
            cookie: `cc_session=${sessionCookie.valueEncoded}`,
            origin,
            "x-csrf-token": paired.csrfToken
          })
      })
      const rejectedMutation = yield* mutationClient.session.logout().pipe(Effect.result)
      assert.isTrue(Result.isFailure(rejectedMutation))
      if (Result.isFailure(rejectedMutation)) {
        assert.strictEqual(rejectedMutation.failure._tag, "ServiceUnavailableApiError")
      }
    }).pipe(
      Effect.provide([FetchHttpClient.layer, NodeServices.layer]),
      Effect.scoped
    ))

  it.effect("runs explicit cache-backed plugin synchronization before serving the authenticated portfolio", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(FIXTURE_TIME))
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const staticRoot = yield* makeStaticFixture
      const dataRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-runtime-sync-" })
      yield* fileSystem.chmod(dataRoot, 0o700)
      const port = yield* acquireEphemeralPort
      const origin = `http://127.0.0.1:${port}`
      const bindConfig = yield* decodeBindConfig({ port })
      const persistenceConfig: PersistenceConfig = {
        blobRoot: BlobRoot.make(path.join(dataRoot, "blobs")),
        busyTimeoutMilliseconds: 5_000,
        databaseUrl: LocalDatabaseUrl.make(`file:${path.join(dataRoot, "control-center.db")}`),
        maxConnections: 1
      }
      yield* Effect.scoped(
        Effect.gen(function*() {
          const persistence = yield* Persistence
          yield* persistence.workspaces.create(WORKSPACE_ID, {
            displayName: WorkspaceName.make("Runtime sync"),
            createdAt: FIXTURE_TIME
          })
          yield* persistence.pluginConnections.create(WORKSPACE_ID, {
            pluginConnectionId: PLUGIN_ID,
            providerId: "jira",
            displayName: PluginConnectionDisplayName.make("Runtime Jira"),
            isEnabled: true,
            createdAt: FIXTURE_TIME
          })
          yield* persistence.pluginRuntime.acceptPluginDescriptor(
            WORKSPACE_ID,
            PLUGIN_ID,
            "jira",
            fakeDescriptor,
            0,
            FIXTURE_TIME
          )
        }).pipe(Effect.provide(persistenceLayer(persistenceConfig)))
      )
      const currentRuntimeAuthority = yield* seedAuthorizedRuntimeAction(persistenceConfig)
      const pluginConnections = yield* makeFakeConnectionMap
      const governedRuntime = yield* makeFakePluginRuntime(governedScenario)
      const runtime = yield* Layer.build(makeControlCenterServer({
        bindConfig,
        persistenceConfig,
        secretRoot: SecretRoot.make(path.join(dataRoot, "secrets")),
        staticAssets: { root: staticRoot },
        bootstrap: {
          workspaceId: WORKSPACE_ID,
          workspaceName: WorkspaceName.make("Runtime sync"),
          owner: { _tag: "human", personId: OWNER_ID }
        },
        releaseSynchronization: {
          input: { workspaceId: WORKSPACE_ID, pluginConnectionId: PLUGIN_ID, streamKey: "releases" },
          pluginConnections
        },
        governedActionExecution: {
          pluginRuntimes: {
            layer: () =>
              Layer.merge(
                governedRuntime.layer,
                Layer.succeed(PluginRuntimeAuthority, currentRuntimeAuthority.runtimeAuthorityToken)
              )
          }
        }
      }))
      const bootstrapState = Context.get(runtime, ControlCenterBootstrap)
      const governedExecution = Context.getOption(runtime, GovernedActionExecutionStartup)
      const synchronizationState = Context.get(runtime, ReleaseSynchronizationStartup)
      const runtimePersistence = Context.get(runtime, Persistence)
      const persistedRuntime = yield* runtimePersistence.pluginRuntime.getRuntime(WORKSPACE_ID, PLUGIN_ID)
      assert.strictEqual(bootstrapState._tag, "pairing-issued")
      assert.isTrue(Option.isNone(governedExecution))
      const internalWorker = yield* Layer.build(
        governedActionExecutionStartupLayer({
          pluginRuntimes: {
            layer: () =>
              Layer.merge(
                governedRuntime.layer,
                Layer.succeed(PluginRuntimeAuthority, currentRuntimeAuthority.runtimeAuthorityToken)
              )
          }
        }).pipe(Layer.provide(databaseLayer(persistenceConfig)))
      )
      const privateExecution = Context.get(internalWorker, GovernedActionExecutionStartup)
      assert.strictEqual(privateExecution._tag, "ready")
      if (privateExecution._tag === "ready") {
        const missing = yield* privateExecution.advance({
          workspaceId: WORKSPACE_ID,
          actionId: MISSING_ACTION_ID
        }).pipe(Effect.flip)
        assert.strictEqual(missing._tag, "GovernedActionExecutionStoreError")
        if (missing._tag === "GovernedActionExecutionStoreError") {
          assert.strictEqual(missing.reason, "not-found")
        }
        const beforeAuthorized = yield* governedRuntime.probe.snapshot
        assert.strictEqual(beforeAuthorized.providerMutations, 0)
        assert.lengthOf(
          beforeAuthorized.calls.filter(({ operation }) => operation === "execute-authorized-action"),
          0
        )

        yield* TestClock.setTime(DateTime.toEpochMillis(GOVERNED_FIXTURE_TIME))
        assert.deepStrictEqual(
          yield* privateExecution.advance({
            workspaceId: AUTHORIZED_WORKSPACE,
            actionId: AUTHORIZED_ACTION
          }),
          { _tag: "advanced", state: "succeeded" }
        )
        const persistedAction = yield* runtimePersistence.governedActions.read({
          workspaceId: AUTHORIZED_WORKSPACE,
          actionId: AUTHORIZED_ACTION
        })
        const afterAuthorized = yield* governedRuntime.probe.snapshot
        assert.strictEqual(persistedAction.head.state, "succeeded")
        assert.strictEqual(persistedAction.headTransition.command._tag, "recordSucceeded")
        assert.strictEqual(afterAuthorized.providerMutations, 1)
        assert.lengthOf(
          afterAuthorized.calls.filter(({ operation }) => operation === "execute-authorized-action"),
          1
        )
        yield* TestClock.setTime(DateTime.toEpochMillis(FIXTURE_TIME))
      }
      assert.strictEqual(persistedRuntime.health._tag, "healthy")
      assert.deepStrictEqual(synchronizationState, {
        _tag: "completed",
        outcome: { _tag: "synchronized", pagesCommitted: 1, releaseId: RELEASE_ID }
      })
      if (bootstrapState._tag !== "pairing-issued") return

      const requestHeaders = (client: HttpClient.HttpClient, headers: Readonly<Record<string, string>>) =>
        client.pipe(HttpClient.mapRequest(HttpClientRequest.setHeaders(headers)))
      const pairClient = yield* makeControlCenterApiClient({
        baseUrl: origin,
        transformClient: (client) => requestHeaders(client, { origin })
      })
      const [, pairResponse] = yield* pairClient.session.pair({
        payload: { pairingCode: PairingCode.make(Redacted.value(bootstrapState.pairingCode)) },
        responseMode: "decoded-and-response"
      })
      const sessionCookie = pairResponse.cookies.cookies.cc_session
      assert.isDefined(sessionCookie)
      if (sessionCookie === undefined) return
      const authenticatedClient = yield* makeControlCenterApiClient({
        baseUrl: origin,
        transformClient: (client) =>
          requestHeaders(client, {
            cookie: `cc_session=${sessionCookie.valueEncoded}`,
            origin
          })
      })
      const portfolio = yield* authenticatedClient.portfolio.snapshot()
      assert.strictEqual(portfolio.releases[0]?.releaseId, RELEASE_ID)
      assert.strictEqual(portfolio.releases[0]?.collaboratorCount, 2)
      assert.strictEqual(portfolio.plugins[0]?.providerId, "jira")
    }).pipe(
      Effect.provide([FetchHttpClient.layer, NodeServices.layer]),
      Effect.scoped
    ))

  it.effect("recovers crash-committed cache while a disabled connection remains provider-inert", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(FIXTURE_TIME))
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const staticRoot = yield* makeStaticFixture
      const dataRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-runtime-disabled-" })
      yield* fileSystem.chmod(dataRoot, 0o700)
      const port = yield* acquireEphemeralPort
      const bindConfig = yield* decodeBindConfig({ port })
      const persistenceConfig: PersistenceConfig = {
        blobRoot: BlobRoot.make(path.join(dataRoot, "blobs")),
        busyTimeoutMilliseconds: 5_000,
        databaseUrl: LocalDatabaseUrl.make(`file:${path.join(dataRoot, "control-center.db")}`),
        maxConnections: 1
      }
      yield* Effect.scoped(
        Effect.gen(function*() {
          const persistence = yield* Persistence
          yield* persistence.workspaces.create(WORKSPACE_ID, {
            displayName: WorkspaceName.make("Runtime disabled recovery"),
            createdAt: FIXTURE_TIME
          })
          yield* persistence.pluginConnections.create(WORKSPACE_ID, {
            pluginConnectionId: PLUGIN_ID,
            providerId: "jira",
            displayName: PluginConnectionDisplayName.make("Disabled Jira"),
            isEnabled: false,
            createdAt: FIXTURE_TIME
          })
          yield* persistence.pluginRuntime.acceptPluginDescriptor(
            WORKSPACE_ID,
            PLUGIN_ID,
            "jira",
            fakeDescriptor,
            0,
            FIXTURE_TIME
          )
          const healthy = yield* Schema.decodeUnknownEffect(PluginHealth)({
            _tag: "healthy",
            checkedAt: FIXTURE_TIME_INPUT
          })
          const page = yield* Schema.decodeUnknownEffect(PluginSyncPageV1)(fakeReleasePage)
          yield* persistence.pluginRuntime.commitNormalizedPage(
            WORKSPACE_ID,
            PLUGIN_ID,
            "jira",
            RELEASE_STREAM,
            0,
            page,
            FIXTURE_TIME,
            healthy
          )
          const missingProjection = yield* persistence.releases.get(
            WORKSPACE_ID,
            RELEASE_ID
          ).pipe(Effect.result)
          assert.strictEqual(missingProjection._tag, "Failure")
        }).pipe(Effect.provide(persistenceLayer(persistenceConfig)))
      )
      yield* TestClock.adjust("6 minutes")

      const providerAcquisitions = yield* Ref.make(0)
      const fakeConnections = yield* makeFakeConnectionMap
      const pluginConnections = {
        contextEffect: (scope: Parameters<PluginConnectionMapV1["contextEffect"]>[0]) =>
          Ref.update(providerAcquisitions, (count) => count + 1).pipe(
            Effect.andThen(fakeConnections.contextEffect(scope))
          ),
        invalidate: fakeConnections.invalidate
      } satisfies PluginConnectionMapV1
      const runtime = yield* Layer.build(makeControlCenterServer({
        bindConfig,
        persistenceConfig,
        secretRoot: SecretRoot.make(path.join(dataRoot, "secrets")),
        staticAssets: { root: staticRoot },
        bootstrap: {
          workspaceId: WORKSPACE_ID,
          workspaceName: WorkspaceName.make("Runtime disabled recovery"),
          owner: { _tag: "human", personId: OWNER_ID }
        },
        releaseSynchronization: {
          input: { workspaceId: WORKSPACE_ID, pluginConnectionId: PLUGIN_ID, streamKey: "releases" },
          pluginConnections
        }
      }))
      const synchronizationState = Context.get(runtime, ReleaseSynchronizationStartup)
      const runtimePersistence = Context.get(runtime, Persistence)
      const release = yield* runtimePersistence.releases.get(WORKSPACE_ID, RELEASE_ID)

      assert.deepStrictEqual(synchronizationState, { _tag: "connection-disabled" })
      assert.strictEqual(yield* Ref.get(providerAcquisitions), 0)
      assert.strictEqual(release.release.id, RELEASE_ID)
      assert.strictEqual(release.release.freshness._tag, "stale")
      assert.strictEqual(release.release.freshness.pluginHealth._tag, "healthy")
      assert.strictEqual(release.release.freshness.provenance._tag, "cache")
    }).pipe(
      Effect.provide([FetchHttpClient.layer, NodeServices.layer]),
      Effect.scoped
    ))
})
