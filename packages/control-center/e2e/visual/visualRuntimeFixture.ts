import * as NodeServices from "@effect/platform-node/NodeServices"
import * as AwsClientConfig from "@knpkv/codecommit-core/AwsClientConfig.js"
import { installCaptureClock, VISUAL_TIME } from "@knpkv/design-conformance/capture"
import { type Page, test as base } from "@playwright/test"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as HttpClient from "effect/http/HttpClient"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Path from "effect/Path"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

import { PersonId, WorkspaceId } from "../../src/domain/identifiers.js"
import { Auth } from "../../src/server/auth/Auth.js"
import { databaseLayer } from "../../src/server/persistence/Database.js"
import { persistenceLayerFromDatabase } from "../../src/server/persistence/Persistence.js"
import { BlobRoot, LocalDatabaseUrl, type PersistenceConfig } from "../../src/server/persistence/PersistenceConfig.js"
import { WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { QuarantineRepository } from "../../src/server/persistence/repositories/quarantineRepository.js"
import { CodePipelineReadClient } from "../../src/server/plugins/codepipeline/CodePipelineReadClient.js"
import { CodePipelineReadProvider } from "../../src/server/plugins/codepipeline/CodePipelineReadProvider.js"
import {
  codeCommitClientsLayer,
  makeFirstPartyPluginRuntimeRegistry
} from "../../src/server/plugins/internal/FirstPartyPluginRuntimeRegistry.js"
import { pluginRuntimeAuthoritySourceLayer } from "../../src/server/plugins/internal/PluginRuntimeAuthorityRepository.js"
import { PluginRuntimeRegistry } from "../../src/server/plugins/internal/PluginRuntimeRegistry.js"
import { ControlCenterBootstrap } from "../../src/server/runtime/Bootstrap.js"
import { makeControlCenterServer } from "../../src/server/runtime/ControlCenterServer.js"
import { SecretRoot, SecretStore } from "../../src/server/secrets/SecretStore.js"
import { decodeBindConfig } from "../../src/server/security/BindConfig.js"
import { acquireEphemeralPort } from "../realRuntimeFixture.js"
import { disposeFailedFixtureSetup, protectPartialFixtureAllocation } from "../realRuntimeLifecycle.js"
import { makeCodePipelineProvider } from "./fakeProviders/codepipeline.js"
import { type FakeProviders, makeFakeProviders } from "./fakeProviders/transport.js"
import { makeVisualRequestAudit, type VisualApiRequest } from "./requestAudit.js"

export { VISUAL_TIME }
export const VISUAL_WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000001")
const OWNER_ID = PersonId.make("01890f6f-6d6a-7cc0-98d2-000000000002")
const epochMillis = 1784030400000

export class VisualFixtureFailure extends Schema.TaggedError<VisualFixtureFailure>()(
  "VisualFixtureFailure",
  { reason: Schema.String }
) {
  override get message(): string {
    return this.reason
  }
}

const liveClock = Effect.runSync(Clock.Clock)

const allocate = Effect.fn("visual.allocate")(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fileSystem.makeTempDirectory({ prefix: "control-center-visual-" })
  return yield* protectPartialFixtureAllocation(
    Effect.gen(function*() {
      yield* fileSystem.chmod(root, 0o700)
      const port = yield* acquireEphemeralPort
      return {
        root,
        origin: `http://127.0.0.1:${port}`,
        port,
        staticRoot: yield* path.fromFileUrl(new URL("../../dist/client/", import.meta.url)),
        secretRoot: SecretRoot.make(path.join(root, "secrets")),
        persistenceConfig: {
          blobRoot: BlobRoot.make(path.join(root, "blobs")),
          databaseUrl: LocalDatabaseUrl.make(`file:${path.join(root, "control-center.db")}`),
          busyTimeoutMilliseconds: 5000,
          maxConnections: 1
        } satisfies PersistenceConfig
      }
    }),
    fileSystem.remove(root, { force: true, recursive: true })
  )
})

export interface VisualRuntimeFixture {
  readonly origin: string
  readonly providers: FakeProviders
  readonly pipeline: ReturnType<typeof makeCodePipelineProvider>
  readonly pairThroughUi: (page: Page) => Promise<void>
  readonly issuePairingCode: () => Promise<string>
  readonly applicationLogEntries: () => ReadonlyArray<string>
  readonly apiRequests: () => ReadonlyArray<VisualApiRequest>
  readonly advanceClockBy: (milliseconds: number) => string
  readonly dispose: () => Promise<void>
}

/** Start the real server and real provider registry. Only provider I/O is deterministic. */
export const startVisualRuntimeFixture = async (): Promise<VisualRuntimeFixture> => {
  const allocated = await Effect.runPromise(allocate().pipe(Effect.provide(NodeServices.layer)))
  let clockEpochMillis = epochMillis
  const clockLayer = Layer.succeed(Clock.Clock, {
    sleep: (duration) => liveClock.sleep(duration),
    monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: liveClock.monotonicTimeNanos,
    currentTimeMillisUnsafe: () => clockEpochMillis,
    currentTimeMillis: Effect.sync(() => clockEpochMillis),
    currentTimeNanosUnsafe: () => BigInt(clockEpochMillis) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(clockEpochMillis) * 1_000_000n)
  })
  const apiAudit = makeVisualRequestAudit()
  const providers = makeFakeProviders()
  const pipeline = makeCodePipelineProvider(providers)
  const applicationLogEntries: Array<string> = []
  const logCapture = Logger.layer([Logger.make<unknown, void>((entry) => {
    applicationLogEntries.push(Logger.formatJson.log(entry))
  })])
  const runtimes: Array<{ readonly dispose: () => Promise<void> }> = []
  const dispose = async (): Promise<void> => {
    const failures: Array<unknown> = []
    for (const runtime of [...runtimes].reverse()) {
      try {
        await runtime.dispose()
      } catch (failure) {
        failures.push(failure)
      }
    }
    try {
      await Effect.runPromise(
        Effect.flatMap(
          FileSystem.FileSystem,
          (fileSystem) => fileSystem.remove(allocated.root, { recursive: true, force: true })
        ).pipe(Effect.provide(NodeServices.layer))
      )
    } catch (failure) {
      failures.push(failure)
    }
    for (const failure of providers.unhandled()) failures.push(failure)
    if (failures.length > 0) throw new AggregateError(failures, "visual fixture teardown failed")
  }
  try {
    const awsConfiguration = AwsClientConfig.layer({
      credentialProvider: ({ profile }) =>
        Promise.resolve({
          accessKeyId: profile.endsWith("-b") ? "FIXTUREB" : "FIXTUREA",
          secretAccessKey: "fixture-secret-invalid-for-aws"
        }),
      maxRetries: 0
    })
    let nextId = 10
    const cryptoLayer = Layer.effect(
      Crypto.Crypto,
      Effect.map(Crypto.Crypto, (cryptoService) => ({
        "~effect/Crypto": "~effect/Crypto",
        nextIntUnsafe: () => cryptoService.nextIntUnsafe(),
        nextDoubleUnsafe: () => cryptoService.nextDoubleUnsafe(),
        randomBytes: (size) => cryptoService.randomBytes(size),
        digest: (algorithm, data) => cryptoService.digest(algorithm, data),
        random: cryptoService.random,
        randomBoolean: cryptoService.randomBoolean,
        randomInt: cryptoService.randomInt,
        randomBetween: (min, max) => cryptoService.randomBetween(min, max),
        randomIntBetween: (min, max, options) => cryptoService.randomIntBetween(min, max, options),
        randomShuffle: (elements) => cryptoService.randomShuffle(elements),
        randomUUIDv4: cryptoService.randomUUIDv4,
        randomULID: cryptoService.randomULID,
        randomUUIDv7: Effect.sync(() => `01890f6f-6d6a-7cc0-98d2-${String(nextId++).padStart(12, "0")}`)
      }))
    ).pipe(Layer.provide(NodeServices.layer))
    const platform = Layer.mergeAll(NodeServices.layer, clockLayer, cryptoLayer, apiAudit.layer)
    const database = databaseLayer(allocated.persistenceConfig)
    const foundation = Layer.mergeAll(
      persistenceLayerFromDatabase(allocated.persistenceConfig).pipe(Layer.provide(database)),
      QuarantineRepository.layer.pipe(Layer.provideMerge(database)),
      SecretStore.layer({ secretRoot: allocated.secretRoot }),
      Layer.succeed(HttpClient.HttpClient, providers.client)
    ).pipe(Layer.provideMerge(platform))
    const registryRuntime = ManagedRuntime.make(
      Layer.unwrap(
        Effect.map(
          CodePipelineReadClient,
          (client) =>
            makeFirstPartyPluginRuntimeRegistry(codeCommitClientsLayer(providers.client, awsConfiguration), client)
        )
      ).pipe(
        Layer.provide(
          CodePipelineReadClient.layer.pipe(Layer.provide(Layer.succeed(CodePipelineReadProvider, pipeline.service)))
        ),
        Layer.provide(pluginRuntimeAuthoritySourceLayer),
        Layer.provide(foundation)
      )
    )
    runtimes.push(registryRuntime)
    const registryContext = await registryRuntime.context()
    const bindConfig = await Effect.runPromise(decodeBindConfig({ port: allocated.port }))
    const serverRuntime = ManagedRuntime.make(
      makeControlCenterServer({
        bindConfig,
        persistenceConfig: allocated.persistenceConfig,
        secretRoot: allocated.secretRoot,
        staticAssets: { root: allocated.staticRoot },
        firstPartyPluginRuntime: true,
        firstPartyPluginRuntimes: Context.get(registryContext, PluginRuntimeRegistry),
        outboundHttpClient: providers.client,
        codeCommitHttpClient: providers.client,
        codeCommitAwsConfiguration: awsConfiguration,
        bootstrap: {
          workspaceId: VISUAL_WORKSPACE_ID,
          workspaceName: WorkspaceName.make("Fixture workspace"),
          owner: { _tag: "human", personId: OWNER_ID }
        }
      }).pipe(Layer.provideMerge(platform), Layer.provideMerge(logCapture))
    )
    runtimes.push(serverRuntime)
    const context = await serverRuntime.context()
    const bootstrap = Context.get(context, ControlCenterBootstrap)
    if (bootstrap._tag !== "pairing-issued") {
      throw new VisualFixtureFailure({ reason: "bootstrap did not issue pairing" })
    }
    const auth = Context.get(context, Auth)
    const ownerSession = await serverRuntime.runPromise(auth.consumePairingCode(bootstrap.pairingCode))
    const issuePairingCode = async (): Promise<string> => {
      const pairing = await serverRuntime.runPromise(
        auth.issuePairingCode(ownerSession.sessionToken, {
          actor: { _tag: "human", personId: OWNER_ID },
          permission: "workspace-owner"
        })
      )
      return Redacted.value(pairing.pairingCode)
    }
    return {
      origin: allocated.origin,
      providers,
      pipeline,
      dispose,
      issuePairingCode,
      apiRequests: apiAudit.requests,
      applicationLogEntries: () => [...applicationLogEntries],
      advanceClockBy: (milliseconds) => {
        clockEpochMillis += Schema.decodeUnknownSync(Schema.Int.check(Schema.isGreaterThan(0)))(milliseconds)
        return DateTime.formatIso(DateTime.makeUnsafe(clockEpochMillis))
      },
      pairThroughUi: async (page) => {
        const pairingCode = await issuePairingCode()
        await page.goto(`${allocated.origin}/pair`)
        await page.getByLabel("Pairing code").fill(pairingCode)
        const response = page.waitForResponse((response) =>
          response.request().method() === "POST" && response.url().includes("/session/pair")
        )
        await page.getByRole("button", { name: "Pair browser" }).click()
        const paired = await response
        if (!paired.ok()) {
          throw new VisualFixtureFailure({ reason: `pairing failed: ${paired.status()} ${await paired.text()}` })
        }
      }
    }
  } catch (failure) {
    return await disposeFailedFixtureSetup(failure, dispose)
  }
}

export const test = base.extend<{ readonly visualRuntime: VisualRuntimeFixture }>({
  visualRuntime: async ({ browserName }, use, testInfo) => {
    if (browserName !== "chromium") throw new VisualFixtureFailure({ reason: "visual suite requires chromium" })
    const runtime = await startVisualRuntimeFixture()
    try {
      await use(runtime)
    } finally {
      try {
        await testInfo.attach("application-logs", {
          body: runtime.applicationLogEntries().join("\n"),
          contentType: "application/x-ndjson"
        })
        await testInfo.attach("api-requests", {
          body: JSON.stringify(runtime.apiRequests(), null, 2),
          contentType: "application/json"
        })
        await testInfo.attach("provider-requests", {
          body: JSON.stringify(runtime.providers.requests(), null, 2),
          contentType: "application/json"
        })
      } finally {
        await runtime.dispose()
      }
    }
  },
  page: async ({ context, visualRuntime }, use, testInfo) => {
    const blocked: Array<string> = []
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url())
      if (url.origin === visualRuntime.origin) await route.continue()
      else {
        blocked.push(url.origin)
        await route.abort("blockedbyclient")
      }
    })
    const page = await context.newPage()
    try {
      await installCaptureClock(page)
      await page.addInitScript(`(() => {
        Object.defineProperty(crypto, 'getRandomValues', { value: function(array) {
          let seed = Number(sessionStorage.getItem('__fixture_random_seed') ?? '17');
          const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
          for (let index = 0; index < bytes.length; index++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            bytes[index] = seed >>> 24;
          }
          sessionStorage.setItem('__fixture_random_seed', String(seed));
          return array;
        } });
      })()`)
      await use(page)
      if (blocked.length > 0) {
        throw new VisualFixtureFailure({ reason: `browser attempted external origins: ${blocked.join(", ")}` })
      }
    } finally {
      try {
        if (!page.isClosed() && testInfo.status !== testInfo.expectedStatus) {
          await testInfo.attach("failure-dom", {
            body: await page.locator("body").ariaSnapshot(),
            contentType: "text/yaml"
          })
        }
      } finally {
        await page.close()
      }
    }
  }
})
