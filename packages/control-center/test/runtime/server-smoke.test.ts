import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { createServer } from "node:net"

import { makeControlCenterApiClient } from "../../src/api/client.js"
import { PairingCode } from "../../src/api/session.js"
import {
  EnvironmentId,
  PersonId,
  PluginConnectionId,
  ReleaseId,
  RoleAssignmentId,
  WorkspaceId
} from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { Persistence, persistenceLayer } from "../../src/server/persistence/Persistence.js"
import { BlobRoot, LocalDatabaseUrl, type PersistenceConfig } from "../../src/server/persistence/PersistenceConfig.js"
import { PluginConnectionDisplayName, WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { makeFakePluginRuntime } from "../../src/server/plugins/fake/FakePluginDefinition.js"
import { type FakePluginScenario, fakeSyncScriptKey } from "../../src/server/plugins/fake/FakePluginScenario.js"
import { PluginConnection } from "../../src/server/plugins/PluginConnection.js"
import type { PluginConnectionMapV1 } from "../../src/server/plugins/PluginConnectionMap.js"
import { ControlCenterBootstrap } from "../../src/server/runtime/Bootstrap.js"
import { makeControlCenterServer } from "../../src/server/runtime/ControlCenterServer.js"
import { ReleaseSynchronizationStartup } from "../../src/server/runtime/ReleaseSynchronizationStartup.js"
import { SecretRoot } from "../../src/server/secrets/SecretStore.js"
import { decodeBindConfig } from "../../src/server/security/BindConfig.js"

const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000071")
const OWNER_ID = PersonId.make("01890f6f-6d6a-7cc0-98d2-000000000072")
const PLUGIN_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000073")
const RELEASE_ID = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000074")
const APPROVER_ID = PersonId.make("01890f6f-6d6a-7cc0-98d2-000000000075")
const ENVIRONMENT_ID = EnvironmentId.make("01890f6f-6d6a-7cc0-98d2-000000000076")
const OWNER_ASSIGNMENT_ID = RoleAssignmentId.make("01890f6f-6d6a-7cc0-98d2-000000000077")
const APPROVER_ASSIGNMENT_ID = RoleAssignmentId.make("01890f6f-6d6a-7cc0-98d2-000000000078")
const FIXTURE_TIME = Schema.decodeSync(UtcTimestamp)("2024-07-14T09:02:00.000Z")

const fakeDescriptor = {
  contractId: "dev.knpkv.control-center.plugin",
  contractVersion: { major: 1, minor: 0, patch: 0 },
  pluginId: "dev.knpkv.fake-jira",
  adapterVersion: { major: 0, minor: 1, patch: 0 },
  displayName: "Deterministic Jira",
  configurationFields: [],
  capabilities: [{ capabilityId: "sync.incremental", supportedVersions: [1], requirement: "required" }]
}

const fakeScenario: FakePluginScenario = {
  descriptor: fakeDescriptor,
  discover: { _tag: "outage" },
  health: { _tag: "success", value: { _tag: "healthy", checkedAt: "2024-07-14T09:02:00.000Z" } },
  sync: {
    [fakeSyncScriptKey("releases", null)]: [{
      _tag: "success",
      value: {
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
    }]
  },
  readEntity: { _tag: "outage" },
  proposeAction: { _tag: "outage" },
  preflight: { _tag: "outage" },
  executeAuthorizedAction: { _tag: "outage" },
  requestCancellation: { _tag: "outage" },
  reconcile: {}
}

const makeFakeConnectionMap = Effect.gen(function*() {
  const runtime = yield* makeFakePluginRuntime(fakeScenario)
  const runtimeContext = yield* Layer.build(runtime.layer)
  const connectionContext = Context.make(PluginConnection, Context.get(runtimeContext, PluginConnection))
  return {
    contextEffect: () => Effect.succeed(connectionContext),
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
      assert.strictEqual(bootstrapState._tag, "pairing-issued")
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
      const pluginConnections = yield* makeFakeConnectionMap
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
        }
      }))
      const bootstrapState = Context.get(runtime, ControlCenterBootstrap)
      const synchronizationState = Context.get(runtime, ReleaseSynchronizationStartup)
      const runtimePersistence = Context.get(runtime, Persistence)
      const persistedRuntime = yield* runtimePersistence.pluginRuntime.getRuntime(WORKSPACE_ID, PLUGIN_ID)
      assert.strictEqual(bootstrapState._tag, "pairing-issued")
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
})
