import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Redacted from "effect/Redacted"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { createServer } from "node:net"

import { makeControlCenterApiClient } from "../../src/api/client.js"
import { PairingCode } from "../../src/api/session.js"
import { PersonId, WorkspaceId } from "../../src/domain/identifiers.js"
import { BlobRoot, LocalDatabaseUrl, type PersistenceConfig } from "../../src/server/persistence/PersistenceConfig.js"
import { WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { ControlCenterBootstrap } from "../../src/server/runtime/Bootstrap.js"
import { makeControlCenterServer } from "../../src/server/runtime/ControlCenterServer.js"
import { SecretRoot } from "../../src/server/secrets/SecretStore.js"
import { decodeBindConfig } from "../../src/server/security/BindConfig.js"

const WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000071")
const OWNER_ID = PersonId.make("01890f6f-6d6a-7cc0-98d2-000000000072")

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
})
