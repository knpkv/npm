import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import type { MarkdownConverter } from "@knpkv/confluence-to-markdown"
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref, Result, Schema, Stream } from "effect"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as TestClock from "effect/testing/TestClock"

import { PluginConnectionId, WorkspaceId } from "../../src/domain/identifiers.js"
import { PluginSyncPageV1 } from "../../src/domain/plugins/events.js"
import { type ProviderId, VendorImmutableId } from "../../src/domain/sourceRevision.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { ApplicationServiceUnavailable } from "../../src/server/api/ApplicationServices.js"
import {
  firstPartyManualPluginSyncDrivers,
  makeManualPluginSyncDriverRegistry,
  makeManualPluginSynchronization
} from "../../src/server/application/manualPluginSynchronization.js"
import { databaseLayer } from "../../src/server/persistence/Database.js"
import { PersistenceOperationError } from "../../src/server/persistence/errors.js"
import { Persistence, persistenceLayerFromDatabase } from "../../src/server/persistence/Persistence.js"
import { PluginConnectionDisplayName, WorkspaceName } from "../../src/server/persistence/repositories/models.js"
import { PluginStreamKey } from "../../src/server/persistence/repositories/pluginRuntimeModels.js"
import {
  ConfluencePageAdapterConfiguration,
  makeConfluencePageAdapter
} from "../../src/server/plugins/confluence/ConfluencePageAdapter.js"
import type { ConfluencePageClientShape } from "../../src/server/plugins/confluence/ConfluencePageClient.js"
import { confluencePagePluginDescriptor } from "../../src/server/plugins/confluence/ConfluencePagePluginDefinition.js"
import { makeJiraReadPluginRuntimeFromProvider } from "../../src/server/plugins/jira/JiraReadPlugin.js"
import type { JiraReadProvider } from "../../src/server/plugins/jira/JiraReadProvider.js"
import { negotiatePluginDescriptorV1 } from "../../src/server/plugins/negotiation.js"
import { PluginConnection, type PluginConnectionV1 } from "../../src/server/plugins/PluginConnection.js"
import type { PluginConnectionMapV1 } from "../../src/server/plugins/PluginConnectionMap.js"
import { DomainEventWakeups } from "../../src/server/runtime/DomainEventWakeups.js"
import { makePersistenceTestConfig } from "../persistence/fixtures.js"

const WORKSPACE_ID = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000203")
const SYNCHRONIZED_AT = Schema.decodeSync(UtcTimestamp)("2026-07-19T12:00:00.000Z")
const PAGE_COMMITTED_AT = Schema.decodeSync(UtcTimestamp)("2026-07-19T12:01:00.000Z")
const PROVIDER_OBSERVED_AT = Schema.decodeSync(UtcTimestamp)("2026-07-19T12:00:01.000Z")

const fixtures = [
  {
    providerId: "codecommit",
    pluginConnectionId: Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000204"),
    streamKey: "pull-requests",
    checkpoint: "codecommit-complete",
    entityType: "pull-request",
    vendorImmutableId: "17",
    title: "Guard refund writes",
    attributes: {
      repository: "payments-api",
      sourceBranch: "feat/guard-refunds",
      targetBranch: "main",
      headRevision: "abc123",
      reviewState: "requested"
    }
  },
  {
    providerId: "codepipeline",
    pluginConnectionId: Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000205"),
    streamKey: "executions",
    checkpoint: "codepipeline-complete",
    entityType: "aws.codepipeline.execution",
    vendorImmutableId: "execution-42",
    title: "payments · execution-42",
    attributes: {
      pipelineName: "payments",
      executionId: "execution-42",
      status: "Succeeded",
      sourceRevisions: [{ revisionId: "abc123" }]
    }
  },
  {
    providerId: "clockify",
    pluginConnectionId: Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000206"),
    streamKey: "time-entries",
    checkpoint: "clockify-complete",
    entityType: "clockify.time-entry",
    vendorImmutableId: "time-entry-7",
    title: "Investigate PAY-42",
    attributes: {
      durationMinutes: 30,
      billable: true,
      approvalState: "pending"
    }
  },
  {
    providerId: "jira",
    pluginConnectionId: Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000207"),
    streamKey: "project-issues",
    checkpoint: "jira-complete",
    entityType: "jira.issue",
    vendorImmutableId: "10042",
    title: "PAY-42 · Protect payment retries",
    attributes: {
      key: "PAY-42",
      status: { name: "In Review" },
      priority: { name: "High" }
    }
  },
  {
    providerId: "confluence",
    pluginConnectionId: Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000208"),
    streamKey: "pages",
    checkpoint: "confluence-complete",
    entityType: "confluence-page",
    vendorImmutableId: "page-42",
    title: "Payments release runbook",
    attributes: {
      spaceId: "space-payments",
      currentVersion: 3,
      contentState: "lazy"
    }
  }
] satisfies ReadonlyArray<{
  readonly providerId: ProviderId
  readonly pluginConnectionId: PluginConnectionId
  readonly streamKey: string
  readonly checkpoint: string
  readonly entityType: string
  readonly vendorImmutableId: string
  readonly title: string
  readonly attributes: Readonly<Record<string, unknown>>
}>

const descriptor = (providerId: ProviderId) => ({
  contractId: "dev.knpkv.control-center.plugin",
  contractVersion: { major: 1, minor: 0, patch: 0 },
  pluginId: `dev.knpkv.${providerId}.fixture`,
  adapterVersion: { major: 1, minor: 0, patch: 0 },
  displayName: `${providerId} fixture`,
  configurationFields: [],
  capabilities: [{ capabilityId: "sync.incremental", supportedVersions: [1], requirement: "required" }]
})

const pageFor = (
  fixture: typeof fixtures[number],
  title = fixture.title,
  observedAt = SYNCHRONIZED_AT
) =>
  Schema.decodeSync(PluginSyncPageV1)({
    checkpointAfterPage: fixture.checkpoint,
    hasMore: false,
    events: [{
      _tag: "UpsertEntity",
      eventId: `${fixture.providerId}-entity-1`,
      observedAt: DateTime.formatIso(observedAt),
      revision: "revision-1",
      entityType: fixture.entityType,
      vendorImmutableId: fixture.vendorImmutableId,
      sourceUrl: null,
      title,
      attributes: fixture.attributes
    }]
  })

const emptyPage = (checkpointAfterPage: string, hasMore: boolean) =>
  Schema.decodeSync(PluginSyncPageV1)({ checkpointAfterPage, events: [], hasMore })

const CONFLUENCE_PAGE_ID = "42"
const CONFLUENCE_UPDATED_AT = "2026-07-19T11:00:00.000Z"
const confluencePage = {
  id: CONFLUENCE_PAGE_ID,
  status: "current",
  title: "Payments release runbook",
  spaceId: "space-payments",
  ownerId: "account-owner",
  createdAt: "2026-07-01T09:00:00.000Z",
  version: {
    number: 3,
    createdAt: CONFLUENCE_UPDATED_AT,
    message: "Approve rollout",
    authorId: "account-author"
  },
  _links: { webui: `/wiki/spaces/PAY/pages/${CONFLUENCE_PAGE_ID}` }
}
const confluenceConfiguration = Schema.decodeUnknownSync(ConfluencePageAdapterConfiguration)({
  siteBaseUrl: "https://acme.atlassian.net",
  siteId: "site-acme",
  spaceId: "space-payments",
  probePageId: CONFLUENCE_PAGE_ID
})
const confluenceConverter: MarkdownConverter["Service"] = {
  adfToMarkdown: () => Effect.succeed(""),
  markdownToAdf: (value) => Effect.succeed(value)
}

const confluenceClient = (overrides: Partial<ConfluencePageClientShape> = {}): ConfluencePageClientShape => ({
  getCurrentUser: Effect.succeed({ accountId: "account-author", displayName: "Avery" }),
  getSystemInfo: Effect.succeed({ cloudId: "site-acme", siteTitle: "Acme" }),
  getPage: () => Effect.succeed(confluencePage),
  getSpacePages: () => Effect.succeed({ results: [confluencePage] }),
  getPageAttachments: () => Effect.succeed({ results: [] }),
  getPageWatchers: (_pageId, start) => Effect.succeed({ results: [], start, limit: 50, size: 0 }),
  getPageVersions: () => Effect.succeed({ results: [confluencePage.version] }),
  getUsers: (accountIds) =>
    Effect.succeed({
      results: accountIds.map((accountId) => ({
        accountId,
        displayName: accountId,
        accountStatus: "active"
      }))
    }),
  ...overrides
})

const makeConfluenceConnection = Effect.fn("ManualPluginSynchronizationTest.makeConfluenceConnection")(
  function*(client: ConfluencePageClientShape) {
    const cryptoService = yield* Crypto.Crypto
    const negotiated = yield* negotiatePluginDescriptorV1(confluencePagePluginDescriptor)
    return makeConfluencePageAdapter({
      client,
      configuration: confluenceConfiguration,
      converter: confluenceConverter,
      cryptoService,
      descriptor: negotiated
    }).connection
  }
)

const confluenceConnections = (
  fixture: typeof fixtures[number],
  connection: PluginConnectionV1
): PluginConnectionMapV1 => ({
  contextEffect: ({ pluginConnectionId }) =>
    pluginConnectionId === fixture.pluginConnectionId
      ? Effect.succeed(Context.make(PluginConnection, connection))
      : Effect.die("fixture connection not found"),
  invalidate: () => Effect.void
})

const withApplication = <Success, Failure>(
  use: Effect.Effect<Success, Failure, Crypto.Crypto | Persistence | DomainEventWakeups>
) =>
  Effect.gen(function*() {
    const config = yield* makePersistenceTestConfig("control-center-manual-sync-")
    const database = databaseLayer(config)
    const persistence = persistenceLayerFromDatabase(config).pipe(Layer.provideMerge(database))
    return yield* use.pipe(Effect.provide([persistence, DomainEventWakeups.layer]))
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)

const setupFixture = Effect.fn("ManualPluginSynchronizationTest.setupFixture")(function*(
  fixture: typeof fixtures[number]
) {
  const persistence = yield* Persistence
  const streamKey = Schema.decodeSync(PluginStreamKey)(fixture.streamKey)
  yield* persistence.workspaces.create(WORKSPACE_ID, {
    displayName: WorkspaceName.make("Payments"),
    createdAt: SYNCHRONIZED_AT
  })
  yield* persistence.pluginConnections.create(WORKSPACE_ID, {
    pluginConnectionId: fixture.pluginConnectionId,
    providerId: fixture.providerId,
    displayName: PluginConnectionDisplayName.make(`${fixture.providerId} fixture`),
    isEnabled: true,
    createdAt: SYNCHRONIZED_AT
  })
  yield* persistence.pluginRuntime.acceptPluginDescriptor(
    WORKSPACE_ID,
    fixture.pluginConnectionId,
    fixture.providerId,
    descriptor(fixture.providerId),
    0,
    SYNCHRONIZED_AT
  )
  const connection: PluginConnectionV1 = {
    descriptor: yield* negotiatePluginDescriptorV1(descriptor(fixture.providerId)),
    discover: Effect.die("not used"),
    health: Effect.succeed({ _tag: "healthy", checkedAt: SYNCHRONIZED_AT }),
    sync: () => Stream.die("driver owns synchronization"),
    readEntity: () => Effect.die("not used"),
    diff: Option.none(),
    proposeAction: () => Effect.die("not used")
  }
  const connections: PluginConnectionMapV1 = {
    contextEffect: ({ pluginConnectionId }) =>
      pluginConnectionId === fixture.pluginConnectionId
        ? Effect.succeed(Context.make(PluginConnection, connection))
        : Effect.die("fixture connection not found"),
    invalidate: () => Effect.void
  }
  return { connections, persistence, streamKey }
})

describe("manual plugin synchronization", () => {
  it("registers Jira only after its first-party adapter negotiates incremental synchronization", () => {
    const driver = firstPartyManualPluginSyncDrivers.get("jira")
    assert.isTrue(Option.isSome(driver))
    if (Option.isSome(driver)) assert.strictEqual(driver.value.streamKey, "project-issues")
  })

  it.effect("commits a Jira page at or after observations made after the initial health sample", () =>
    withApplication(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(SYNCHRONIZED_AT))
      const fixture = fixtures.find(({ providerId }) => providerId === "jira")
      if (fixture === undefined) return yield* Effect.die("jira fixture not found")
      const { connections, persistence } = yield* setupFixture(fixture)
      const drivers = makeManualPluginSyncDriverRegistry([{
        providerId: fixture.providerId,
        streamKey: fixture.streamKey,
        sync: () =>
          Stream.fromEffect(
            TestClock.adjust("1 second").pipe(
              Effect.as(pageFor(fixture, fixture.title, PROVIDER_OBSERVED_AT))
            )
          )
      }])
      const synchronization = yield* makeManualPluginSynchronization(connections, drivers)

      const synchronized = yield* synchronization.synchronize({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: fixture.pluginConnectionId
      })

      assert.strictEqual(synchronized.result, "synchronized")
      assert.strictEqual(synchronized.pagesCommitted, 1)
      const entity = yield* persistence.entities.findBySourceIdentity(WORKSPACE_ID, {
        pluginConnectionId: fixture.pluginConnectionId,
        providerId: "jira",
        vendorImmutableId: VendorImmutableId.make(fixture.vendorImmutableId)
      })
      assert.strictEqual(DateTime.formatIso(entity.sourceRevision.lastObservedAt), "2026-07-19T12:00:01.000Z")
      assert.strictEqual(DateTime.formatIso(entity.sourceRevision.synchronizedAt), "2026-07-19T12:00:01.000Z")
    })))

  it.effect("accepts a bounded Jira invocation as terminal while persisting its durable cursor", () =>
    withApplication(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(SYNCHRONIZED_AT))
      const fixture = fixtures.find(({ providerId }) => providerId === "jira")
      if (fixture === undefined) return yield* Effect.die("jira fixture not found")
      const { persistence } = yield* setupFixture(fixture)
      const provider: JiraReadProvider = {
        getCurrentUser: Effect.succeed({
          accountId: "ari",
          displayName: "Ari Chen",
          active: true,
          timeZone: "UTC"
        }),
        getServerInfo: Effect.succeed({ baseUrl: "https://acme.atlassian.net", serverTitle: "Acme Jira" }),
        getProject: () => Effect.succeed({ id: "10", key: "PAY", name: "Payments" }),
        getIssue: () => Effect.succeed(Option.none()),
        getComments: (_issueId, request) =>
          Effect.succeed({ comments: [], startAt: request.startAt, maxResults: request.maxResults, total: 0 }),
        getChangelogs: (_issueId, request) =>
          Effect.succeed({ values: [], startAt: request.startAt, maxResults: request.maxResults, total: 0 }),
        searchProjectIssues: () =>
          Effect.succeed({
            issues: [{
              id: "10042",
              key: "PAY-42",
              fields: {
                summary: "Protect payment retries",
                updated: "2026-07-17T09:30:00.000Z",
                project: { id: "10", key: "PAY", name: "Payments" }
              }
            }],
            nextPageToken: "provider-page-2"
          })
      }
      const runtime = makeJiraReadPluginRuntimeFromProvider(provider, {
        webBaseUrl: "https://acme.atlassian.net",
        siteId: "cloud-acme",
        projectId: "10",
        pageSize: 1,
        maximumPages: 1,
        operationTimeoutMillis: 5_000
      }, "cloud-acme")
      const connections: PluginConnectionMapV1 = {
        contextEffect: ({ pluginConnectionId }) =>
          pluginConnectionId === fixture.pluginConnectionId
            ? Layer.build(runtime.layer)
            : Effect.die("fixture connection not found"),
        invalidate: () => Effect.void
      }
      const synchronization = yield* makeManualPluginSynchronization(connections)

      const synchronized = yield* synchronization.synchronize({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: fixture.pluginConnectionId
      })

      assert.strictEqual(synchronized.result, "synchronized")
      assert.strictEqual(synchronized.pagesCommitted, 1)
      const stream = yield* persistence.pluginRuntime.getStream(
        WORKSPACE_ID,
        fixture.pluginConnectionId,
        Schema.decodeSync(PluginStreamKey)(fixture.streamKey)
      )
      assert.include(stream.checkpointJson ?? "", "provider-page-2")
    })))

  it.effect("materializes each supported fixture connection once and exposes replay-safe attempt state", () =>
    withApplication(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(SYNCHRONIZED_AT))
      const persistence = yield* Persistence
      yield* persistence.workspaces.create(WORKSPACE_ID, {
        displayName: WorkspaceName.make("Payments"),
        createdAt: SYNCHRONIZED_AT
      })
      for (const fixture of fixtures) {
        yield* persistence.pluginConnections.create(WORKSPACE_ID, {
          pluginConnectionId: fixture.pluginConnectionId,
          providerId: fixture.providerId,
          displayName: PluginConnectionDisplayName.make(`${fixture.providerId} fixture`),
          isEnabled: true,
          createdAt: SYNCHRONIZED_AT
        })
        yield* persistence.pluginRuntime.acceptPluginDescriptor(
          WORKSPACE_ID,
          fixture.pluginConnectionId,
          fixture.providerId,
          descriptor(fixture.providerId),
          0,
          SYNCHRONIZED_AT
        )
      }

      const requests = yield* Ref.make<
        Array<{
          readonly providerId: ProviderId
          readonly checkpoint: string | null
        }>
      >([])
      const drivers = makeManualPluginSyncDriverRegistry(fixtures.map((fixture) => ({
        providerId: fixture.providerId,
        streamKey: fixture.streamKey,
        sync: (_connection, request) =>
          Stream.fromEffect(
            Ref.update(requests, (current) => [
              ...current,
              { providerId: fixture.providerId, checkpoint: request.checkpoint }
            ]).pipe(Effect.as(pageFor(fixture)))
          )
      })))
      const connectionsById = new Map<PluginConnectionId, PluginConnectionV1>()
      for (const fixture of fixtures) {
        const connection: PluginConnectionV1 = {
          descriptor: yield* negotiatePluginDescriptorV1(descriptor(fixture.providerId)),
          discover: Effect.die("not used"),
          health: Effect.succeed({ _tag: "healthy", checkedAt: SYNCHRONIZED_AT }),
          sync: () => Stream.die("driver owns synchronization"),
          readEntity: () => Effect.die("not used"),
          diff: Option.none(),
          proposeAction: () => Effect.die("not used")
        }
        connectionsById.set(fixture.pluginConnectionId, connection)
      }
      const connections: PluginConnectionMapV1 = {
        contextEffect: ({ pluginConnectionId }) => {
          const connection = connectionsById.get(pluginConnectionId)
          return connection === undefined
            ? Effect.die("fixture connection not found")
            : Effect.succeed(Context.make(PluginConnection, connection))
        },
        invalidate: () => Effect.void
      }
      const synchronization = yield* makeManualPluginSynchronization(connections, drivers)

      for (const fixture of fixtures) {
        const initial = yield* synchronization.state({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: fixture.pluginConnectionId
        })
        assert.strictEqual(initial.result, "never")
        const synchronized = yield* synchronization.synchronize({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: fixture.pluginConnectionId
        })
        assert.strictEqual(synchronized.result, "synchronized")
        assert.strictEqual(synchronized.pagesCommitted, 1)
        assert.isNotNull(synchronized.lastSuccessAt)
      }

      const itemRead = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "workspaceEntityProjections",
        owner: null,
        query: null,
        service: null,
        status: null,
        type: null,
        limit: 100
      })
      if (itemRead._tag !== "workspaceEntityProjections") return yield* Effect.die("expected Items projection")
      assert.deepStrictEqual(
        itemRead.value.items.map(({ projection }) => projection.entityType).sort(),
        ["issue", "page", "pipeline-execution", "pull-request", "time-entry"]
      )
      const timelineBeforeReplay = (yield* persistence.timeline.page({
        workspaceId: WORKSPACE_ID,
        actorKind: "plugin",
        before: null,
        entityId: null,
        from: null,
        limit: 100,
        to: null
      })).filter(({ sourceKind }) => sourceKind === "plugin-sync")
      assert.deepStrictEqual(
        timelineBeforeReplay.map(({ service }) => service).sort(),
        ["clockify", "codecommit", "codepipeline", "confluence", "jira"]
      )

      for (const fixture of fixtures) {
        const replay = yield* synchronization.synchronize({
          workspaceId: WORKSPACE_ID,
          pluginConnectionId: fixture.pluginConnectionId
        })
        assert.strictEqual(replay.result, "synchronized")
        assert.strictEqual(replay.pagesCommitted, 0)
      }
      const replayedItems = yield* persistence.deliveryGraph.read(WORKSPACE_ID, {
        _tag: "workspaceEntityProjections",
        owner: null,
        query: null,
        service: null,
        status: null,
        type: null,
        limit: 100
      })
      if (replayedItems._tag !== "workspaceEntityProjections") return yield* Effect.die("expected Items projection")
      assert.strictEqual(replayedItems.value.totalCount, 5)
      const timelineAfterReplay = (yield* persistence.timeline.page({
        workspaceId: WORKSPACE_ID,
        actorKind: "plugin",
        before: null,
        entityId: null,
        from: null,
        limit: 100,
        to: null
      })).filter(({ sourceKind }) => sourceKind === "plugin-sync")
      assert.lengthOf(timelineAfterReplay, timelineBeforeReplay.length)
      assert.deepStrictEqual(
        yield* Ref.get(requests),
        [
          ...fixtures.map((fixture) => ({ providerId: fixture.providerId, checkpoint: null })),
          ...fixtures.map((fixture) => ({
            providerId: fixture.providerId,
            checkpoint: fixture.checkpoint
          }))
        ]
      )
    })))

  it.effect("completes changed provider identity replays as malformed source failures", () =>
    withApplication(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(SYNCHRONIZED_AT))
      const fixture = fixtures.find(({ providerId }) => providerId === "codecommit")
      if (fixture === undefined) return yield* Effect.die("codecommit fixture not found")
      const { connections, persistence, streamKey } = yield* setupFixture(fixture)
      const page = yield* Ref.make(pageFor(fixture))
      const drivers = makeManualPluginSyncDriverRegistry([{
        providerId: fixture.providerId,
        streamKey: fixture.streamKey,
        sync: () => Stream.fromEffect(Ref.get(page))
      }])
      const synchronization = yield* makeManualPluginSynchronization(connections, drivers)

      const initial = yield* synchronization.synchronize({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: fixture.pluginConnectionId
      })
      assert.strictEqual(initial.result, "synchronized")
      assert.strictEqual(initial.pagesCommitted, 1)

      yield* Ref.set(page, pageFor(fixture, "Changed after the provider reused its identity"))
      const conflicted = yield* synchronization.synchronize({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: fixture.pluginConnectionId
      })

      assert.strictEqual(conflicted.result, "source-unavailable")
      assert.strictEqual(conflicted.pagesCommitted, 0)
      const attempts = yield* persistence.pluginRuntime.listSyncAttempts(
        WORKSPACE_ID,
        fixture.pluginConnectionId,
        streamKey
      )
      assert.lengthOf(attempts, 2)
      assert.strictEqual(attempts[1]?.outcome, "source-unavailable")
      const runtime = yield* persistence.pluginRuntime.getRuntime(WORKSPACE_ID, fixture.pluginConnectionId)
      assert.strictEqual(runtime.health._tag, "unavailable")
      if (runtime.health._tag === "unavailable") {
        assert.strictEqual(runtime.health.failureClass, "malformed-response")
      }
    })))

  it.effect("commits a page observed after its health probe at the current clock time", () =>
    withApplication(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(SYNCHRONIZED_AT))
      const fixture = fixtures.find(({ providerId }) => providerId === "codecommit")
      if (fixture === undefined) return yield* Effect.die("codecommit fixture not found")
      const { connections, persistence, streamKey } = yield* setupFixture(fixture)
      const page = pageFor(fixture)
      const encodedPage = Schema.encodeSync(PluginSyncPageV1)(page)
      const observedAfterHealth = Schema.decodeSync(PluginSyncPageV1)({
        ...encodedPage,
        events: encodedPage.events.map((event) => ({
          ...event,
          observedAt: DateTime.formatIso(PAGE_COMMITTED_AT)
        }))
      })
      const drivers = makeManualPluginSyncDriverRegistry([{
        providerId: fixture.providerId,
        streamKey: fixture.streamKey,
        sync: () =>
          Stream.fromEffect(
            TestClock.setTime(DateTime.toEpochMillis(PAGE_COMMITTED_AT)).pipe(
              Effect.as(observedAfterHealth)
            )
          )
      }])
      const synchronization = yield* makeManualPluginSynchronization(connections, drivers)

      const synchronized = yield* synchronization.synchronize({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: fixture.pluginConnectionId
      })

      assert.strictEqual(synchronized.result, "synchronized")
      const stream = yield* persistence.pluginRuntime.getStream(
        WORKSPACE_ID,
        fixture.pluginConnectionId,
        streamKey
      )
      assert.isTrue(
        stream.synchronizedAt !== null && DateTime.Equivalence(stream.synchronizedAt, PAGE_COMMITTED_AT)
      )
    })))

  it.effect("commits changed Confluence inventory under a new replay-safe event identity", () =>
    withApplication(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(SYNCHRONIZED_AT))
      const fixture = fixtures.find(({ providerId }) => providerId === "confluence")
      if (fixture === undefined) return yield* Effect.die("confluence fixture not found")
      const { persistence, streamKey } = yield* setupFixture(fixture)
      let attachmentTitle = "release-v1.txt"
      let displayName = "Avery One"
      const connection = yield* makeConfluenceConnection(confluenceClient({
        getPageAttachments: () =>
          Effect.sync(() => ({
            results: [{
              id: "attachment-1",
              status: "current",
              title: attachmentTitle,
              createdAt: CONFLUENCE_UPDATED_AT,
              pageId: CONFLUENCE_PAGE_ID,
              version: { number: 1 }
            }]
          })),
        getUsers: (accountIds) =>
          Effect.sync(() => ({
            results: accountIds.map((accountId) => ({
              accountId,
              displayName,
              accountStatus: "active"
            }))
          }))
      }))
      const drivers = makeManualPluginSyncDriverRegistry([{
        providerId: fixture.providerId,
        streamKey: fixture.streamKey,
        sync: (pluginConnection, request) => pluginConnection.sync(request)
      }])
      const synchronization = yield* makeManualPluginSynchronization(
        confluenceConnections(fixture, connection),
        drivers
      )
      const input = { workspaceId: WORKSPACE_ID, pluginConnectionId: fixture.pluginConnectionId }

      const initial = yield* synchronization.synchronize(input)
      const replay = yield* synchronization.synchronize(input)
      assert.strictEqual(initial.result, "synchronized")
      assert.strictEqual(initial.pagesCommitted, 1)
      assert.strictEqual(replay.result, "synchronized")
      assert.strictEqual(replay.pagesCommitted, 0)

      attachmentTitle = "release-v2.txt"
      displayName = "Avery Two"
      const changed = yield* synchronization.synchronize(input)
      assert.strictEqual(changed.result, "synchronized")
      assert.strictEqual(changed.pagesCommitted, 1)
      const stream = yield* persistence.pluginRuntime.getStream(
        WORKSPACE_ID,
        fixture.pluginConnectionId,
        streamKey
      )
      assert.strictEqual(stream.revision, 2)
      const attempts = yield* persistence.pluginRuntime.listSyncAttempts(
        WORKSPACE_ID,
        fixture.pluginConnectionId,
        streamKey
      )
      assert.deepStrictEqual(attempts.map(({ outcome }) => outcome), [
        "synchronized",
        "synchronized",
        "synchronized"
      ])
    })))

  it.effect("restores a terminal Confluence checkpoint when only an earlier provider page changes", () =>
    withApplication(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(SYNCHRONIZED_AT))
      const fixture = fixtures.find(({ providerId }) => providerId === "confluence")
      if (fixture === undefined) return yield* Effect.die("confluence fixture not found")
      const { persistence, streamKey } = yield* setupFixture(fixture)
      const laterPage = {
        ...confluencePage,
        id: "43",
        title: "Payments deployment notes",
        _links: { webui: "/wiki/spaces/PAY/pages/43" }
      }
      let firstAttachmentTitle = "release-v1.txt"
      const connection = yield* makeConfluenceConnection(confluenceClient({
        getSpacePages: (_spaceId, cursor) =>
          Effect.succeed(
            cursor === null
              ? { results: [confluencePage], _links: { next: "/pages?cursor=c1" } }
              : { results: [laterPage] }
          ),
        getPageAttachments: (pageId) =>
          Effect.succeed({
            results: pageId === CONFLUENCE_PAGE_ID
              ? [{
                id: "attachment-1",
                status: "current",
                title: firstAttachmentTitle,
                createdAt: CONFLUENCE_UPDATED_AT,
                pageId,
                version: { number: 1 }
              }]
              : []
          }),
        getPageVersions: (pageId) =>
          Effect.succeed({ results: [pageId === CONFLUENCE_PAGE_ID ? confluencePage.version : laterPage.version] })
      }))
      const drivers = makeManualPluginSyncDriverRegistry([{
        providerId: fixture.providerId,
        streamKey: fixture.streamKey,
        sync: (pluginConnection, request) => pluginConnection.sync(request)
      }])
      const synchronization = yield* makeManualPluginSynchronization(
        confluenceConnections(fixture, connection),
        drivers
      )
      const input = { workspaceId: WORKSPACE_ID, pluginConnectionId: fixture.pluginConnectionId }

      const initial = yield* synchronization.synchronize(input)
      const replay = yield* synchronization.synchronize(input)
      assert.strictEqual(initial.pagesCommitted, 2)
      assert.strictEqual(replay.pagesCommitted, 0)

      firstAttachmentTitle = "release-v2.txt"
      const changed = yield* synchronization.synchronize(input)
      assert.strictEqual(changed.result, "synchronized")
      assert.strictEqual(changed.pagesCommitted, 2)
      const stream = yield* persistence.pluginRuntime.getStream(
        WORKSPACE_ID,
        fixture.pluginConnectionId,
        streamKey
      )
      assert.strictEqual(stream.revision, 4)
      assert.match(stream.checkpointJson ?? "", /^"complete:[0-9a-f]{64}"$/u)
    })))

  it.effect("does not commit a page for a non-advancing stored Confluence cursor", () =>
    withApplication(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(SYNCHRONIZED_AT))
      const fixture = fixtures.find(({ providerId }) => providerId === "confluence")
      if (fixture === undefined) return yield* Effect.die("confluence fixture not found")
      const setup = yield* setupFixture(fixture)
      const seedDrivers = makeManualPluginSyncDriverRegistry([{
        providerId: fixture.providerId,
        streamKey: fixture.streamKey,
        sync: () => Stream.succeed(emptyPage("next:c1", false))
      }])
      const seed = yield* makeManualPluginSynchronization(setup.connections, seedDrivers)
      const input = { workspaceId: WORKSPACE_ID, pluginConnectionId: fixture.pluginConnectionId }
      const seeded = yield* seed.synchronize(input)
      assert.strictEqual(seeded.result, "synchronized")
      assert.strictEqual(seeded.pagesCommitted, 1)

      let advance = false
      let metadataCalls = 0
      const connection = yield* makeConfluenceConnection(confluenceClient({
        getSpacePages: (_spaceId, cursor) =>
          Effect.sync(() =>
            !advance
              ? { results: [confluencePage], _links: { next: `/pages?cursor=${cursor}` } }
              : cursor === "c1"
              ? { results: [], _links: { next: "/pages?cursor=c2" } }
              : { results: [] }
          ),
        getPageVersions: () =>
          Effect.sync(() => {
            metadataCalls += 1
            return { results: [confluencePage.version] }
          })
      }))
      const drivers = makeManualPluginSyncDriverRegistry([{
        providerId: fixture.providerId,
        streamKey: fixture.streamKey,
        sync: (pluginConnection, request) => pluginConnection.sync(request)
      }])
      const synchronization = yield* makeManualPluginSynchronization(
        confluenceConnections(fixture, connection),
        drivers
      )
      const rejected = yield* synchronization.synchronize(input)
      assert.strictEqual(rejected.result, "source-unavailable")
      assert.strictEqual(rejected.pagesCommitted, 0)
      assert.strictEqual(metadataCalls, 0)
      const afterRejected = yield* setup.persistence.pluginRuntime.getStream(
        WORKSPACE_ID,
        fixture.pluginConnectionId,
        setup.streamKey
      )
      assert.strictEqual(afterRejected.revision, 1)
      assert.strictEqual(afterRejected.checkpointJson, "\"next:c1\"")

      advance = true
      const accepted = yield* synchronization.synchronize(input)
      assert.strictEqual(accepted.result, "synchronized")
      assert.strictEqual(accepted.pagesCommitted, 2)
      const afterAccepted = yield* setup.persistence.pluginRuntime.getStream(
        WORKSPACE_ID,
        fixture.pluginConnectionId,
        setup.streamKey
      )
      assert.strictEqual(afterAccepted.revision, 3)
      assert.match(afterAccepted.checkpointJson ?? "", /^"complete:[0-9a-f]{64}"$/u)
    })))

  it.effect("keeps state reads observational and recovers a stale attempt on the next owner sync", () =>
    withApplication(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(SYNCHRONIZED_AT))
      const fixture = fixtures.find(({ providerId }) => providerId === "codecommit")
      if (fixture === undefined) return yield* Effect.die("codecommit fixture not found")
      const { connections, persistence, streamKey } = yield* setupFixture(fixture)
      const drivers = makeManualPluginSyncDriverRegistry([{
        providerId: fixture.providerId,
        streamKey: fixture.streamKey,
        sync: () => Stream.succeed(pageFor(fixture))
      }])
      const commitFailure = new PersistenceOperationError({ operation: "test.manual-sync-page-commit" })
      const failingPersistence = Persistence.of({
        ...persistence,
        pluginRuntime: {
          ...persistence.pluginRuntime,
          commitNormalizedPageReceipt: () => Effect.fail(commitFailure)
        }
      })
      const beforeRestart = yield* makeManualPluginSynchronization(connections, drivers).pipe(
        Effect.provideService(Persistence, failingPersistence)
      )
      const failed = yield* beforeRestart.synchronize({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: fixture.pluginConnectionId
      }).pipe(Effect.result)

      assert.isTrue(Result.isFailure(failed))
      if (Result.isFailure(failed)) assert.instanceOf(failed.failure, ApplicationServiceUnavailable)
      const openAttempts = yield* persistence.pluginRuntime.listSyncAttempts(
        WORKSPACE_ID,
        fixture.pluginConnectionId,
        streamKey
      )
      assert.lengthOf(openAttempts, 1)
      assert.isNull(openAttempts[0]?.outcome)

      const afterRestart = yield* makeManualPluginSynchronization(connections, drivers)
      const observed = yield* afterRestart.state({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: fixture.pluginConnectionId
      })
      assert.strictEqual(observed.result, "running")
      const stillOpen = yield* persistence.pluginRuntime.listSyncAttempts(
        WORKSPACE_ID,
        fixture.pluginConnectionId,
        streamKey
      )
      assert.isNull(stillOpen[0]?.outcome)

      const recovered = yield* afterRestart.synchronize({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: fixture.pluginConnectionId
      })
      assert.strictEqual(recovered.result, "synchronized")
      assert.strictEqual(recovered.pagesCommitted, 1)
      const completedAttempts = yield* persistence.pluginRuntime.listSyncAttempts(
        WORKSPACE_ID,
        fixture.pluginConnectionId,
        streamKey
      )
      assert.lengthOf(completedAttempts, 2)
      assert.strictEqual(completedAttempts[0]?.outcome, "interrupted")
      assert.strictEqual(completedAttempts[1]?.outcome, "synchronized")
    })))

  it.effect("keeps cross-instance state reads observational while rejecting cross-instance overlap", () =>
    withApplication(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(SYNCHRONIZED_AT))
      const fixture = fixtures.find(({ providerId }) => providerId === "codecommit")
      if (fixture === undefined) return yield* Effect.die("codecommit fixture not found")
      const { connections, persistence, streamKey } = yield* setupFixture(fixture)
      const providerCalls = yield* Ref.make(0)
      const providerEntered = yield* Deferred.make<void>()
      const releaseProvider = yield* Deferred.make<void>()
      const drivers = makeManualPluginSyncDriverRegistry([{
        providerId: fixture.providerId,
        streamKey: fixture.streamKey,
        sync: () =>
          Stream.fromEffect(
            Ref.update(providerCalls, (current) => current + 1).pipe(
              Effect.andThen(Deferred.succeed(providerEntered, undefined)),
              Effect.andThen(Deferred.await(releaseProvider)),
              Effect.as(pageFor(fixture))
            )
          )
      }])
      const synchronization = yield* makeManualPluginSynchronization(connections, drivers)
      const observer = yield* makeManualPluginSynchronization(connections, drivers)
      const input = {
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: fixture.pluginConnectionId
      }

      const firstFiber = yield* synchronization.synchronize(input).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(providerEntered)
      const active = yield* observer.state(input)
      assert.strictEqual(active.result, "running")
      const overlapping = yield* observer.synchronize(input).pipe(Effect.result)
      assert.isTrue(Result.isFailure(overlapping))
      if (Result.isFailure(overlapping)) {
        assert.instanceOf(overlapping.failure, ApplicationServiceUnavailable)
      }
      assert.strictEqual(yield* Ref.get(providerCalls), 1)
      const attemptsWhileActive = yield* persistence.pluginRuntime.listSyncAttempts(
        WORKSPACE_ID,
        fixture.pluginConnectionId,
        streamKey
      )
      assert.lengthOf(attemptsWhileActive, 1)
      assert.isNull(attemptsWhileActive[0]?.outcome)

      yield* Deferred.succeed(releaseProvider, undefined)
      const first = yield* Fiber.join(firstFiber)
      assert.strictEqual(first.result, "synchronized")
      const sequential = yield* synchronization.synchronize(input)
      assert.strictEqual(sequential.result, "synchronized")
      assert.strictEqual(sequential.pagesCommitted, 0)
      assert.strictEqual(yield* Ref.get(providerCalls), 2)
    })))

  it.effect("rejects a delayed page after the connection is disabled", () =>
    withApplication(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(SYNCHRONIZED_AT))
      const fixture = fixtures.find(({ providerId }) => providerId === "codecommit")
      if (fixture === undefined) return yield* Effect.die("codecommit fixture not found")
      const { connections, persistence, streamKey } = yield* setupFixture(fixture)
      const providerEntered = yield* Deferred.make<void>()
      const releaseProvider = yield* Deferred.make<void>()
      const drivers = makeManualPluginSyncDriverRegistry([{
        providerId: fixture.providerId,
        streamKey: fixture.streamKey,
        sync: () =>
          Stream.fromEffect(
            Deferred.succeed(providerEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseProvider)),
              Effect.as(pageFor(fixture))
            )
          )
      }])
      const synchronization = yield* makeManualPluginSynchronization(connections, drivers)
      const input = {
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: fixture.pluginConnectionId
      }

      const fiber = yield* synchronization.synchronize(input).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(providerEntered)
      const current = yield* persistence.pluginConnections.get(WORKSPACE_ID, fixture.pluginConnectionId)
      yield* persistence.pluginConnections.updateMetadata(WORKSPACE_ID, fixture.pluginConnectionId, {
        displayName: current.displayName,
        isEnabled: false,
        expectedRevision: current.revision,
        updatedAt: SYNCHRONIZED_AT
      })
      yield* Deferred.succeed(releaseProvider, undefined)

      const result = yield* Fiber.join(fiber)
      assert.strictEqual(result.result, "source-unavailable")
      assert.strictEqual(result.pagesCommitted, 0)
      const stream = yield* persistence.pluginRuntime.getStream(
        WORKSPACE_ID,
        fixture.pluginConnectionId,
        streamKey
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(stream))
      const disabled = yield* persistence.pluginConnections.get(WORKSPACE_ID, fixture.pluginConnectionId)
      assert.isFalse(disabled.isEnabled)
      const runtime = yield* persistence.pluginRuntime.getRuntime(WORKSPACE_ID, fixture.pluginConnectionId)
      assert.strictEqual(runtime.health._tag, "healthy")
    })))

  it.effect("rejects a delayed page after the connection configuration changes", () =>
    withApplication(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(SYNCHRONIZED_AT))
      const fixture = fixtures.find(({ providerId }) => providerId === "codecommit")
      if (fixture === undefined) return yield* Effect.die("codecommit fixture not found")
      const { connections, persistence, streamKey } = yield* setupFixture(fixture)
      const providerEntered = yield* Deferred.make<void>()
      const releaseProvider = yield* Deferred.make<void>()
      const drivers = makeManualPluginSyncDriverRegistry([{
        providerId: fixture.providerId,
        streamKey: fixture.streamKey,
        sync: () =>
          Stream.fromEffect(
            Deferred.succeed(providerEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseProvider)),
              Effect.as(pageFor(fixture))
            )
          )
      }])
      const synchronization = yield* makeManualPluginSynchronization(connections, drivers)

      const fiber = yield* synchronization.synchronize({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: fixture.pluginConnectionId
      }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(providerEntered)
      yield* persistence.pluginConfigurations.update(
        WORKSPACE_ID,
        fixture.pluginConnectionId,
        [],
        0,
        SYNCHRONIZED_AT
      )
      yield* Deferred.succeed(releaseProvider, undefined)

      const result = yield* Fiber.join(fiber)
      assert.strictEqual(result.result, "source-unavailable")
      assert.strictEqual(result.pagesCommitted, 0)
      const stream = yield* persistence.pluginRuntime.getStream(
        WORKSPACE_ID,
        fixture.pluginConnectionId,
        streamKey
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(stream))
      const runtime = yield* persistence.pluginRuntime.getRuntime(WORKSPACE_ID, fixture.pluginConnectionId)
      assert.strictEqual(runtime.health._tag, "healthy")
    })))

  it.effect("rejects a capped invocation made entirely from replayed nonterminal pages", () =>
    withApplication(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(SYNCHRONIZED_AT))
      const fixture = fixtures.find(({ providerId }) => providerId === "codecommit")
      if (fixture === undefined) return yield* Effect.die("codecommit fixture not found")
      const { connections, persistence, streamKey } = yield* setupFixture(fixture)
      const replayedPage = emptyPage("replayed-checkpoint", true)
      const pages = yield* Ref.make<ReadonlyArray<typeof PluginSyncPageV1.Type>>([
        replayedPage,
        emptyPage("terminal-checkpoint", false)
      ])
      const drivers = makeManualPluginSyncDriverRegistry([{
        providerId: fixture.providerId,
        streamKey: fixture.streamKey,
        sync: () => Stream.fromEffect(Ref.get(pages)).pipe(Stream.flatMap(Stream.fromIterable))
      }])
      const synchronization = yield* makeManualPluginSynchronization(connections, drivers)

      const seeded = yield* synchronization.synchronize({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: fixture.pluginConnectionId
      })
      assert.strictEqual(seeded.result, "synchronized")
      assert.strictEqual(seeded.pagesCommitted, 2)

      yield* Ref.set(pages, Array.from({ length: 100 }, () => replayedPage))
      const replayed = yield* synchronization.synchronize({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: fixture.pluginConnectionId
      })

      assert.strictEqual(replayed.result, "source-unavailable")
      assert.strictEqual(replayed.pagesCommitted, 0)
      const stream = yield* persistence.pluginRuntime.getStream(
        WORKSPACE_ID,
        fixture.pluginConnectionId,
        streamKey
      )
      assert.strictEqual(stream.revision, 2)
      assert.strictEqual(stream.checkpointJson, "\"terminal-checkpoint\"")
      const runtime = yield* persistence.pluginRuntime.getRuntime(WORKSPACE_ID, fixture.pluginConnectionId)
      assert.strictEqual(runtime.health._tag, "unavailable")
      if (runtime.health._tag === "unavailable") {
        assert.strictEqual(runtime.health.failureClass, "malformed-response")
      }
    })))

  it.effect("completes the hundredth provider page as successful bounded progress", () =>
    withApplication(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(SYNCHRONIZED_AT))
      const fixture = fixtures.find(({ providerId }) => providerId === "codecommit")
      if (fixture === undefined) return yield* Effect.die("codecommit fixture not found")
      const { connections, persistence, streamKey } = yield* setupFixture(fixture)
      const pages = Array.from(
        { length: 100 },
        (_, index) => emptyPage(`checkpoint-${index + 1}`, true)
      )
      const drivers = makeManualPluginSyncDriverRegistry([{
        providerId: fixture.providerId,
        streamKey: fixture.streamKey,
        sync: () => Stream.fromIterable(pages)
      }])
      const synchronization = yield* makeManualPluginSynchronization(connections, drivers)

      const bounded = yield* synchronization.synchronize({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: fixture.pluginConnectionId
      })

      assert.strictEqual(bounded.result, "synchronized")
      assert.strictEqual(bounded.pagesCommitted, 100)
      const stream = yield* persistence.pluginRuntime.getStream(
        WORKSPACE_ID,
        fixture.pluginConnectionId,
        streamKey
      )
      assert.strictEqual(stream.revision, 100)
      assert.strictEqual(stream.checkpointJson, "\"checkpoint-100\"")
      const runtime = yield* persistence.pluginRuntime.getRuntime(WORKSPACE_ID, fixture.pluginConnectionId)
      assert.strictEqual(runtime.health._tag, "healthy")
    })))

  it.effect("rejects provider output emitted after a terminal page", () =>
    withApplication(Effect.gen(function*() {
      yield* TestClock.setTime(DateTime.toEpochMillis(SYNCHRONIZED_AT))
      const fixture = fixtures.find(({ providerId }) => providerId === "codecommit")
      if (fixture === undefined) return yield* Effect.die("codecommit fixture not found")
      const { connections, persistence, streamKey } = yield* setupFixture(fixture)
      const drivers = makeManualPluginSyncDriverRegistry([{
        providerId: fixture.providerId,
        streamKey: fixture.streamKey,
        sync: () =>
          Stream.fromIterable([
            emptyPage("terminal-checkpoint", false),
            emptyPage("unexpected-checkpoint", false)
          ])
      }])
      const synchronization = yield* makeManualPluginSynchronization(connections, drivers)

      const malformed = yield* synchronization.synchronize({
        workspaceId: WORKSPACE_ID,
        pluginConnectionId: fixture.pluginConnectionId
      })

      assert.strictEqual(malformed.result, "source-unavailable")
      assert.strictEqual(malformed.pagesCommitted, 1)
      const attempts = yield* persistence.pluginRuntime.listSyncAttempts(
        WORKSPACE_ID,
        fixture.pluginConnectionId,
        streamKey
      )
      assert.strictEqual(attempts[0]?.outcome, "source-unavailable")
      const runtime = yield* persistence.pluginRuntime.getRuntime(WORKSPACE_ID, fixture.pluginConnectionId)
      assert.strictEqual(runtime.health._tag, "unavailable")
      if (runtime.health._tag === "unavailable") {
        assert.strictEqual(runtime.health.failureClass, "malformed-response")
      }
    })))
})
