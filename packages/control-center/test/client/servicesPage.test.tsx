// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { type ReactElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, useLocation } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  type AtlassianOAuthGrantStartResponse,
  type AtlassianOAuthProviderIntent,
  CreatePluginConnectionResponse,
  PluginConnectionSummary,
  PluginConnectionTestResult,
  PluginOverviewResponse
} from "../../src/api/plugins.js"
import { CsrfToken, SessionSummary } from "../../src/api/session.js"
import { BrowserSessionProvider, useBrowserSession } from "../../src/client/BrowserSession.js"
import type { ConnectionTestTransport } from "../../src/client/services/connectionTestTransport.js"
import { ServicesPage } from "../../src/client/services/ServicesPage.js"
import {
  FollowedResourceId,
  PersonId,
  PluginConnectionId,
  ProviderAccountId,
  WorkspaceId
} from "../../src/domain/identifiers.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const workspaceId = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000141")
const connection = Schema.decodeSync(PluginConnectionSummary)({
  pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000142",
  providerAccountId: null,
  followedResourceId: null,
  providerId: "jira",
  displayName: "Payments Jira",
  isEnabled: true,
  health: null,
  updatedAt: "2026-07-14T10:00:00.000Z"
})
const confluenceConnection = Schema.decodeSync(PluginConnectionSummary)({
  pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000145",
  providerAccountId: null,
  followedResourceId: null,
  providerId: "confluence",
  displayName: "Payments Confluence",
  isEnabled: true,
  health: null,
  updatedAt: "2026-07-14T10:00:00.000Z"
})
const atlassianOAuthStartCases: ReadonlyArray<{
  readonly connections: ReadonlyArray<PluginConnectionSummary>
  readonly label: string
  readonly providers: AtlassianOAuthProviderIntent
  readonly route: string
}> = [
  {
    connections: [confluenceConnection],
    label: "Jira only",
    providers: ["jira"],
    route: "/services?enable=jira"
  },
  {
    connections: [connection],
    label: "Confluence only",
    providers: ["confluence"],
    route: "/services?enable=confluence"
  },
  {
    connections: [],
    label: "Jira and Confluence",
    providers: ["jira", "confluence"],
    route: "/services?enable=jira"
  }
]
const catalogEntry = (providerId: "codecommit" | "codepipeline" | "jira" | "confluence" | "clockify") => ({
  providerId,
  displayName: providerId,
  description: `Configure ${providerId}.`,
  configurationFields: [
    {
      key: "profile",
      label: "Profile",
      description: "Local configuration value.",
      kind: "text",
      scope: "adapter",
      required: true,
      defaultValue: "default",
      isReadOnly: false,
      minimum: null,
      maximum: null
    }
  ]
})
const overview = Schema.decodeUnknownSync(PluginOverviewResponse)({
  catalog: [
    catalogEntry("codecommit"),
    catalogEntry("codepipeline"),
    catalogEntry("jira"),
    catalogEntry("confluence"),
    catalogEntry("clockify")
  ],
  connections: [Schema.encodeSync(PluginConnectionSummary)(connection)]
})
const session = Schema.decodeSync(SessionSummary)({
  sessionId: "01890f6f-6d6a-7cc0-98d2-000000000143",
  workspaceId,
  actor: {
    _tag: "human",
    personId: Schema.decodeSync(PersonId)("01890f6f-6d6a-7cc0-98d2-000000000144")
  },
  permission: "workspace-owner",
  createdAt: "2026-07-14T10:00:00.000Z",
  lastSeenAt: "2026-07-14T10:01:00.000Z",
  idleExpiresAt: "2026-07-14T22:00:00.000Z",
  absoluteExpiresAt: "2026-08-13T10:00:00.000Z",
  revokedAt: null
})
const csrfToken = Schema.decodeSync(CsrfToken)("ab".repeat(32))

let root: Root | undefined
let sessionControls: ReturnType<typeof useBrowserSession> | undefined
let currentLocation = ""

const LocationProbe = (): null => {
  const location = useLocation()
  currentLocation = `${location.pathname}${location.search}`
  return null
}

const Harness = ({ transport }: { readonly transport: ConnectionTestTransport }): ReactElement => {
  sessionControls = useBrowserSession()
  return <ServicesPage transport={transport} />
}

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount())
  root = undefined
  sessionControls = undefined
  currentLocation = ""
  document.body.replaceChildren()
  sessionStorage.clear()
})

const renderServices = async (transport: ConnectionTestTransport, initialEntry = "/"): Promise<HTMLElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <BrowserSessionProvider>
          <Harness transport={transport} />
          <LocationProbe />
        </BrowserSessionProvider>
      </MemoryRouter>
    )
  )
  await act(async () => sessionControls?.establishSession(csrfToken, session))
  return host
}

const renderAnonymousServices = async (transport: ConnectionTestTransport): Promise<HTMLElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <MemoryRouter>
        <BrowserSessionProvider>
          <Harness transport={transport} />
          <LocationProbe />
        </BrowserSessionProvider>
      </MemoryRouter>
    )
  )
  const hydrationAttempt = sessionControls?.beginHydration()
  if (hydrationAttempt !== undefined) {
    await act(async () => sessionControls?.completeHydration(hydrationAttempt, { _tag: "anonymous" }))
  }
  return host
}

const setControlValue = async (control: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
  const prototype = control.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setValue = Object.getOwnPropertyDescriptor(prototype, "value")?.set
  if (setValue === undefined) throw new Error("Expected the control value setter")
  await act(async () => {
    setValue.call(control, value)
    control.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

const successfulCreate: ConnectionTestTransport["create"] = (request) =>
  Promise.resolve(
    Schema.decodeUnknownSync(CreatePluginConnectionResponse)({
      connection: {
        pluginConnectionId: request.pluginConnectionId,
        providerId: request.providerId,
        displayName: request.displayName,
        isEnabled: true,
        health: null,
        updatedAt: "2026-07-14T10:03:00.000Z"
      },
      configuration: {
        pluginConnectionId: request.pluginConnectionId,
        revision: 1,
        values: request.values.map((value) =>
          value._tag === "secret" ? { _tag: "secret-reference", key: value.key, state: "configured" } : value
        ),
        updatedAt: "2026-07-14T10:03:00.000Z"
      },
      test: {
        _tag: "healthy",
        pluginConnectionId: request.pluginConnectionId,
        providerId: request.providerId,
        checkedAt: "2026-07-14T10:03:00.000Z",
        latencyMilliseconds: 20,
        identity: {
          kind: "user",
          label: "Atlassian user",
          displayName: "Avery Bell",
          providerImmutableId: "account-1"
        }
      }
    })
  )

const successfulAwsCreate = (
  request: Parameters<ConnectionTestTransport["create"]>[0],
  providerAccountId: ProviderAccountId,
  followedResourceId: FollowedResourceId
) =>
  Schema.decodeUnknownSync(CreatePluginConnectionResponse)({
    connection: {
      pluginConnectionId: request.pluginConnectionId,
      providerAccountId,
      followedResourceId,
      providerId: request.providerId,
      displayName: request.displayName,
      isEnabled: true,
      health: null,
      updatedAt: "2026-07-14T10:03:00.000Z"
    },
    configuration: {
      pluginConnectionId: request.pluginConnectionId,
      revision: 1,
      values: request.values,
      updatedAt: "2026-07-14T10:03:00.000Z"
    },
    test: {
      _tag: "healthy",
      pluginConnectionId: request.pluginConnectionId,
      providerId: request.providerId,
      checkedAt: "2026-07-14T10:03:00.000Z",
      latencyMilliseconds: 20,
      identity: {
        kind: "account",
        label: "AWS account",
        displayName: "Production account",
        providerImmutableId: "123456789012"
      }
    }
  })

describe("ServicesPage connection tests", () => {
  it("keeps every service visible while the authenticated overview is still loading", async () => {
    const transport: ConnectionTestTransport = {
      create: vi.fn(),
      overview: () => new Promise(() => undefined),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport)

    expect(host.querySelectorAll("article")).toHaveLength(5)
    expect(host.textContent).toContain("CodeCommit")
    expect(host.textContent).toContain("CodePipeline")
    expect(host.textContent).toContain("Jira")
    expect(host.textContent).toContain("Confluence")
    expect(host.textContent).toContain("Clockify")
    expect(host.textContent).toContain("Loading connections")
  })

  it("shows every available service before the browser is paired", async () => {
    const transport: ConnectionTestTransport = {
      create: vi.fn(),
      overview: vi.fn(),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderAnonymousServices(transport)

    expect(host.querySelectorAll("article")).toHaveLength(5)
    expect(host.textContent).toContain("CodeCommit")
    expect(host.textContent).toContain("CodePipeline")
    expect(host.textContent).toContain("Jira")
    expect(host.textContent).toContain("Confluence")
    expect(host.textContent).toContain("Clockify")
    const actions = [...host.querySelectorAll<HTMLButtonElement>("button")].filter(({ textContent }) =>
      textContent?.includes("Pair to enable")
    )
    expect(actions).toHaveLength(5)
    await act(async () => actions[2]?.click())
    expect(currentLocation).toBe("/pair?service=jira")
  })

  it("opens the selected service setup after pairing", async () => {
    const transport: ConnectionTestTransport = {
      create: vi.fn(),
      overview: () => Promise.resolve({ ...overview, connections: [] }),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport, "/services?enable=jira")
    await act(async () => undefined)

    expect(host.querySelector("form")).not.toBeNull()
    expect(host.textContent).toContain("One identity. Jira and Confluence together.")
    expect(currentLocation).toBe("/services")
  })

  it("discovers AWS profiles and fills the selected profile region", async () => {
    const discoverAwsProfiles = vi.fn().mockResolvedValue([
      { profile: "default", region: "us-east-1" },
      { profile: "production", region: "eu-west-1" }
    ])
    const codeCommit = catalogEntry("codecommit")
    const awsOverview = Schema.decodeUnknownSync(PluginOverviewResponse)({
      catalog: [
        {
          ...codeCommit,
          configurationFields: [
            ...codeCommit.configurationFields,
            {
              key: "region",
              label: "Region",
              description: "Detected AWS region.",
              kind: "text",
              scope: "adapter",
              required: true,
              defaultValue: "us-east-1",
              isReadOnly: false,
              minimum: null,
              maximum: null
            }
          ]
        },
        catalogEntry("codepipeline"),
        catalogEntry("jira"),
        catalogEntry("confluence"),
        catalogEntry("clockify")
      ],
      connections: []
    })
    const transport: ConnectionTestTransport = {
      create: vi.fn(),
      discoverAwsProfiles,
      overview: () => Promise.resolve(awsOverview),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport, "/services?enable=codecommit")
    await act(async () => undefined)

    expect(discoverAwsProfiles).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(host.querySelectorAll("datalist option")).toHaveLength(2)
    const profile = host.querySelector<HTMLInputElement>('input[list="aws-account-profiles"]')
    expect(profile).not.toBeNull()
    if (profile !== null) {
      await setControlValue(profile, "production")
    }
    expect([...host.querySelectorAll<HTMLInputElement>("input")].map(({ value }) => value)).toContain("production")
    expect([...host.querySelectorAll<HTMLInputElement>("input")].map(({ value }) => value)).toContain("eu-west-1")
  })

  it("groups repositories and pipelines under their verified AWS account", async () => {
    const accountId = Schema.decodeSync(ProviderAccountId)("01890f6f-6d6a-7cc0-98d2-000000000171")
    const repositoryId = Schema.decodeSync(FollowedResourceId)("01890f6f-6d6a-7cc0-98d2-000000000172")
    const pipelineId = Schema.decodeSync(FollowedResourceId)("01890f6f-6d6a-7cc0-98d2-000000000173")
    const repositoryConnectionId = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000174")
    const pipelineConnectionId = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000175")
    const awsOverview = Schema.decodeUnknownSync(PluginOverviewResponse)({
      catalog: [
        catalogEntry("codecommit"),
        catalogEntry("codepipeline"),
        catalogEntry("jira"),
        catalogEntry("confluence"),
        catalogEntry("clockify")
      ],
      connections: [
        {
          pluginConnectionId: repositoryConnectionId,
          providerAccountId: accountId,
          followedResourceId: repositoryId,
          providerId: "codecommit",
          displayName: "Payments repository",
          isEnabled: true,
          health: { _tag: "healthy", checkedAt: "2026-07-14T10:00:00.000Z" },
          updatedAt: "2026-07-14T10:00:00.000Z"
        },
        {
          pluginConnectionId: pipelineConnectionId,
          providerAccountId: accountId,
          followedResourceId: pipelineId,
          providerId: "codepipeline",
          displayName: "Payments pipeline",
          isEnabled: true,
          health: { _tag: "healthy", checkedAt: "2026-07-14T10:00:00.000Z" },
          updatedAt: "2026-07-14T10:00:00.000Z"
        }
      ],
      accounts: [
        {
          providerAccountId: accountId,
          providerFamily: "aws",
          displayName: "123456789012",
          providerImmutableId: "123456789012",
          resources: [
            {
              followedResourceId: repositoryId,
              providerId: "codecommit",
              displayName: "payments",
              providerImmutableId: "eu-west-1:payments",
              isEnabled: true
            },
            {
              followedResourceId: pipelineId,
              providerId: "codepipeline",
              displayName: "payments-release",
              providerImmutableId: "arn:aws:codepipeline:eu-west-1:123456789012:payments-release",
              isEnabled: true
            }
          ]
        }
      ]
    })
    const transport: ConnectionTestTransport = {
      create: vi.fn(),
      overview: () => Promise.resolve(awsOverview),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport)
    await act(async () => undefined)

    expect(host.textContent).toContain("Connected accounts")
    expect(host.textContent).toContain("AWS account 123456789012")
    expect(host.textContent).toContain("Verified identity · 123456789012")
    expect(host.textContent).toContain("payments")
    expect(host.textContent).toContain("payments-release")
    expect([...host.querySelectorAll("button")].map(({ textContent }) => textContent)).toEqual(
      expect.arrayContaining(["Add repository", "Add pipeline"])
    )
  })

  it("surfaces failed enablement for a resource inside an AWS account", async () => {
    const accountId = Schema.decodeSync(ProviderAccountId)("01890f6f-6d6a-7cc0-98d2-000000000176")
    const resourceId = Schema.decodeSync(FollowedResourceId)("01890f6f-6d6a-7cc0-98d2-000000000177")
    const connectionId = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000178")
    const awsOverview = Schema.decodeUnknownSync(PluginOverviewResponse)({
      catalog: [
        catalogEntry("codecommit"),
        catalogEntry("codepipeline"),
        catalogEntry("jira"),
        catalogEntry("confluence"),
        catalogEntry("clockify")
      ],
      connections: [
        {
          pluginConnectionId: connectionId,
          providerAccountId: accountId,
          followedResourceId: resourceId,
          providerId: "codecommit",
          displayName: "Payments repository",
          isEnabled: true,
          health: { _tag: "healthy", checkedAt: "2026-07-14T10:00:00.000Z" },
          updatedAt: "2026-07-14T10:00:00.000Z"
        }
      ],
      accounts: [
        {
          providerAccountId: accountId,
          providerFamily: "aws",
          displayName: "123456789012",
          providerImmutableId: "123456789012",
          resources: [
            {
              followedResourceId: resourceId,
              providerId: "codecommit",
              displayName: "payments-api",
              providerImmutableId: "eu-west-1:payments-api",
              isEnabled: true
            }
          ]
        }
      ]
    })
    const setEnabled = vi.fn().mockRejectedValue(new Error("conflict"))
    const transport: ConnectionTestTransport = {
      create: vi.fn(),
      overview: () => Promise.resolve(awsOverview),
      makeConnectionId: () => Promise.resolve(connectionId),
      setEnabled,
      test: vi.fn()
    }
    const host = await renderServices(transport)
    await act(async () => undefined)
    const accountCard = [...host.querySelectorAll<HTMLElement>("article")].find((card) =>
      card.textContent?.includes("AWS account 123456789012")
    )
    const disable = [...(accountCard?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      ({ textContent }) => textContent === "Disable"
    )

    await act(async () => disable?.click())

    expect(setEnabled).toHaveBeenCalledWith(connectionId, false, expect.any(AbortSignal))
    expect(accountCard?.querySelector('[role="alert"]')?.textContent).toContain("could not change this service")
    expect(disable?.disabled).toBe(false)
  })

  it("refreshes an existing AWS account after following another resource", async () => {
    const accountId = Schema.decodeSync(ProviderAccountId)("01890f6f-6d6a-7cc0-98d2-000000000181")
    const paymentsId = Schema.decodeSync(FollowedResourceId)("01890f6f-6d6a-7cc0-98d2-000000000182")
    const riskId = Schema.decodeSync(FollowedResourceId)("01890f6f-6d6a-7cc0-98d2-000000000183")
    const paymentsConnectionId = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000184")
    const riskConnectionId = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000185")
    const textFieldKind: "text" = "text"
    const adapterScope: "adapter" = "adapter"
    const field = (key: string, defaultValue: string | null = null) => ({
      key,
      label: key,
      description: `Configure ${key}.`,
      kind: textFieldKind,
      scope: adapterScope,
      required: true,
      defaultValue,
      isReadOnly: false,
      minimum: null,
      maximum: null
    })
    const codeCommit = catalogEntry("codecommit")
    const codePipeline = catalogEntry("codepipeline")
    const catalog = [
      {
        ...codeCommit,
        configurationFields: [field("profile", "default"), field("region"), field("repositoryName")]
      },
      {
        ...codePipeline,
        configurationFields: [field("profile", "default"), field("region"), field("pipelineName")]
      },
      catalogEntry("jira"),
      catalogEntry("confluence"),
      catalogEntry("clockify")
    ]
    const paymentsConnection = {
      pluginConnectionId: paymentsConnectionId,
      providerAccountId: accountId,
      followedResourceId: paymentsId,
      providerId: "codecommit",
      displayName: "Payments · payments-api",
      isEnabled: true,
      health: { _tag: "healthy", checkedAt: "2026-07-14T10:00:00.000Z" },
      updatedAt: "2026-07-14T10:00:00.000Z"
    }
    const riskConnection = {
      pluginConnectionId: riskConnectionId,
      providerAccountId: accountId,
      followedResourceId: riskId,
      providerId: "codecommit",
      displayName: "Payments · risk-engine",
      isEnabled: true,
      health: { _tag: "healthy", checkedAt: "2026-07-14T10:03:00.000Z" },
      updatedAt: "2026-07-14T10:03:00.000Z"
    }
    const account = {
      providerAccountId: accountId,
      providerFamily: "aws",
      displayName: "123456789012",
      providerImmutableId: "123456789012"
    }
    const paymentsResource = {
      followedResourceId: paymentsId,
      providerId: "codecommit",
      displayName: "payments-api",
      providerImmutableId: "eu-west-1:payments-api",
      isEnabled: true
    }
    const riskResource = {
      followedResourceId: riskId,
      providerId: "codecommit",
      displayName: "risk-engine",
      providerImmutableId: "eu-west-1:risk-engine",
      isEnabled: true
    }
    const initialOverview = Schema.decodeUnknownSync(PluginOverviewResponse)({
      catalog,
      connections: [paymentsConnection],
      accounts: [{ ...account, resources: [paymentsResource] }]
    })
    const refreshedOverview = Schema.decodeUnknownSync(PluginOverviewResponse)({
      catalog,
      connections: [paymentsConnection, riskConnection],
      accounts: [{ ...account, resources: [paymentsResource, riskResource] }]
    })
    const created = Schema.decodeUnknownSync(CreatePluginConnectionResponse)({
      connection: riskConnection,
      configuration: {
        pluginConnectionId: riskConnectionId,
        revision: 1,
        values: [
          { _tag: "text", key: "profile", value: "default" },
          { _tag: "text", key: "region", value: "eu-west-1" },
          { _tag: "text", key: "repositoryName", value: "risk-engine" }
        ],
        updatedAt: "2026-07-14T10:03:00.000Z"
      },
      test: {
        _tag: "healthy",
        pluginConnectionId: riskConnectionId,
        providerId: "codecommit",
        checkedAt: "2026-07-14T10:03:00.000Z",
        latencyMilliseconds: 20,
        identity: {
          kind: "account",
          label: "AWS account",
          displayName: "Production account",
          providerImmutableId: "123456789012"
        }
      }
    })
    const loadOverview = vi.fn().mockResolvedValueOnce(initialOverview).mockResolvedValue(refreshedOverview)
    const transport: ConnectionTestTransport = {
      create: vi.fn().mockResolvedValue(created),
      overview: loadOverview,
      makeConnectionId: () => Promise.resolve(riskConnectionId),
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport)
    await act(async () => undefined)

    const addRepository = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent === "Add repository"
    )
    await act(async () => addRepository?.click())
    expect(host.textContent).not.toContain("Needs correction")
    const region = host.querySelectorAll<HTMLInputElement>("input")[2]
    if (region !== undefined) await setControlValue(region, "eu-west-1")
    const repositories = host.querySelectorAll<HTMLTextAreaElement>("textarea")[0]
    if (repositories !== undefined) await setControlValue(repositories, "risk-engine")
    const submit = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Connect AWS account")
    )
    await act(async () => {
      submit?.click()
      await Promise.resolve()
    })

    expect(loadOverview).toHaveBeenCalledTimes(2)
    const accountCard = [...host.querySelectorAll<HTMLElement>("article")].find((card) =>
      card.textContent?.includes("AWS account 123456789012")
    )
    expect(accountCard?.textContent).toContain("payments-api")
    expect(accountCard?.textContent).toContain("risk-engine")
    expect(accountCard?.textContent?.match(/Healthy/gu)).toHaveLength(2)
  })

  it("does not let an aborted account refresh clear a newer create flow", async () => {
    const accountId = Schema.decodeSync(ProviderAccountId)("01890f6f-6d6a-7cc0-98d2-000000000186")
    const repositoryId = Schema.decodeSync(FollowedResourceId)("01890f6f-6d6a-7cc0-98d2-000000000187")
    const repositoryConnectionId = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000188")
    const pipelineConnectionId = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000189")
    const initialOverview = Schema.decodeUnknownSync(PluginOverviewResponse)({ ...overview, connections: [] })
    let overviewCall = 0
    const loadOverview = vi.fn((_signal: AbortSignal): Promise<PluginOverviewResponse> => {
      overviewCall += 1
      if (overviewCall === 1) return Promise.resolve(initialOverview)
      return new Promise((_resolve, reject) => {
        _signal.addEventListener("abort", () => reject(new Error("aborted refresh")), { once: true })
      })
    })
    let createCall = 0
    const create = vi.fn<ConnectionTestTransport["create"]>((request) => {
      createCall += 1
      if (createCall === 1) return Promise.resolve(successfulAwsCreate(request, accountId, repositoryId))
      return new Promise(() => undefined)
    })
    const connectionIds = [repositoryConnectionId, pipelineConnectionId]
    let connectionIdIndex = 0
    const transport: ConnectionTestTransport = {
      create,
      overview: loadOverview,
      makeConnectionId: () => Promise.resolve(connectionIds[connectionIdIndex++] ?? pipelineConnectionId),
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport, "/services?enable=codecommit")
    await act(async () => undefined)
    const region = host.querySelectorAll<HTMLInputElement>("input")[2]
    if (region !== undefined) await setControlValue(region, "eu-west-1")
    const repositories = host.querySelectorAll<HTMLTextAreaElement>("textarea")[0]
    if (repositories !== undefined) await setControlValue(repositories, "payments-api")
    const firstSubmit = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Connect AWS account")
    )
    await act(async () => {
      firstSubmit?.click()
      await Promise.resolve()
    })
    expect(loadOverview).toHaveBeenCalledTimes(2)

    const configurePipeline = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent === "Configure AWS account"
    )
    await act(async () => configurePipeline?.click())
    const nextRegion = host.querySelectorAll<HTMLInputElement>("input")[2]
    if (nextRegion !== undefined) await setControlValue(nextRegion, "eu-west-1")
    const pipelines = host.querySelectorAll<HTMLTextAreaElement>("textarea")[1]
    if (pipelines !== undefined) await setControlValue(pipelines, "payments-release")
    const secondSubmit = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Connect AWS account")
    )
    await act(async () => {
      secondSubmit?.click()
      await Promise.resolve()
    })

    expect(create).toHaveBeenCalledTimes(2)
    expect(host.querySelector("form")).not.toBeNull()
    expect(host.textContent).toContain("Connect AWS account")
  })

  it("keeps an optimistic account connection when its refresh fails", async () => {
    const accountId = Schema.decodeSync(ProviderAccountId)("01890f6f-6d6a-7cc0-98d2-000000000190")
    const resourceId = Schema.decodeSync(FollowedResourceId)("01890f6f-6d6a-7cc0-98d2-000000000191")
    const connectionId = Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000192")
    const initialOverview = Schema.decodeUnknownSync(PluginOverviewResponse)({ ...overview, connections: [] })
    const loadOverview = vi
      .fn()
      .mockResolvedValueOnce(initialOverview)
      .mockRejectedValueOnce(new Error("refresh unavailable"))
    const transport: ConnectionTestTransport = {
      create: (request) => Promise.resolve(successfulAwsCreate(request, accountId, resourceId)),
      overview: loadOverview,
      makeConnectionId: () => Promise.resolve(connectionId),
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport, "/services?enable=codecommit")
    await act(async () => undefined)
    const region = host.querySelectorAll<HTMLInputElement>("input")[2]
    if (region !== undefined) await setControlValue(region, "eu-west-1")
    const repositories = host.querySelectorAll<HTMLTextAreaElement>("textarea")[0]
    if (repositories !== undefined) await setControlValue(repositories, "payments-api")
    const submit = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Connect AWS account")
    )
    await act(async () => {
      submit?.click()
      await Promise.resolve()
    })

    expect(loadOverview).toHaveBeenCalledTimes(2)
    expect(host.querySelector("form")).toBeNull()
    expect(host.textContent).toContain("AWS account · payments-api")
  })

  it("prefers one discovered OAuth profile for both Jira and Confluence", async () => {
    const field = (
      key: string,
      kind: "integer" | "secret" | "text" | "url" = "text",
      defaultValue: string | null = null,
      required = true
    ) => ({
      key,
      label: key,
      description: `Configure ${key}.`,
      kind,
      scope: kind === "secret" || key === "email" ? "credential" : "adapter",
      required,
      defaultValue,
      isReadOnly: false,
      minimum: null,
      maximum: null
    })
    const jira = catalogEntry("jira")
    const confluence = catalogEntry("confluence")
    const atlassianOverview = Schema.decodeUnknownSync(PluginOverviewResponse)({
      catalog: [
        catalogEntry("codecommit"),
        catalogEntry("codepipeline"),
        {
          ...jira,
          configurationFields: [
            field("webBaseUrl", "url"),
            field("authMode", "text", "oauth"),
            field("oauthProfileId", "text", null, false),
            field("email", "text", null, false),
            field("apiToken", "secret", null, false),
            field("pageSize", "integer", "50"),
            field("maximumPages", "integer", "5"),
            field("operationTimeoutMillis", "integer", "30000")
          ]
        },
        {
          ...confluence,
          configurationFields: [
            field("siteBaseUrl", "url"),
            field("authMode", "text", "oauth"),
            field("oauthProfileId", "text", null, false),
            field("email", "text", null, false),
            field("apiToken", "secret", null, false),
            field("siteId"),
            field("spaceId"),
            field("probePageId")
          ]
        },
        catalogEntry("clockify")
      ],
      connections: []
    })
    const connectionIds = [
      Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000161"),
      Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000162")
    ]
    const create = vi.fn<ConnectionTestTransport["create"]>((request) =>
      Promise.resolve(
        Schema.decodeUnknownSync(CreatePluginConnectionResponse)({
          connection: {
            pluginConnectionId: request.pluginConnectionId,
            providerId: request.providerId,
            displayName: request.displayName,
            isEnabled: true,
            health: null,
            updatedAt: "2026-07-14T10:03:00.000Z"
          },
          configuration: {
            pluginConnectionId: request.pluginConnectionId,
            revision: 1,
            values: request.values.map((value) =>
              value._tag === "secret" ? { _tag: "secret-reference", key: value.key, state: "configured" } : value
            ),
            updatedAt: "2026-07-14T10:03:00.000Z"
          },
          test: {
            _tag: "healthy",
            pluginConnectionId: request.pluginConnectionId,
            providerId: request.providerId,
            checkedAt: "2026-07-14T10:03:00.000Z",
            latencyMilliseconds: 20,
            identity: {
              kind: "user",
              label: "Atlassian user",
              displayName: "Avery Bell",
              providerImmutableId: "account-1"
            }
          }
        })
      )
    )
    const makeConnectionId = vi.fn().mockResolvedValueOnce(connectionIds[0]).mockResolvedValueOnce(connectionIds[1])
    const transport: ConnectionTestTransport = {
      create,
      discoverAtlassianProfiles: () =>
        Promise.resolve([
          {
            profileId: "account-1@cloud-1",
            name: "Avery Bell @ team.atlassian.net",
            siteUrl: "https://team.atlassian.net/",
            cloudId: "cloud-1",
            accountName: "Avery Bell",
            accountEmail: "avery@example.com",
            status: "valid",
            providers: ["jira", "confluence"]
          }
        ]),
      overview: () => Promise.resolve(atlassianOverview),
      makeConnectionId,
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport, "/services?enable=jira")
    await act(async () => undefined)

    expect(host.textContent).toContain("Avery Bell @ team.atlassian.net")
    const submit = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Connect Atlassian")
    )
    await act(async () => submit?.click())
    expect(create).not.toHaveBeenCalled()

    const inputs = host.querySelectorAll<HTMLInputElement>("input")
    expect(inputs[3]?.required).toBe(true)
    expect(inputs[4]?.required).toBe(true)
    if (inputs[3] !== undefined) await setControlValue(inputs[3], "space-1")
    if (inputs[4] !== undefined) await setControlValue(inputs[4], "page-1")
    await act(async () => submit?.click())

    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls.map(([request]) => request.providerId)).toEqual(["jira", "confluence"])
    for (const [request] of create.mock.calls) {
      expect(request.values).toContainEqual({ _tag: "text", key: "authMode", value: "oauth" })
      expect(request.values).toContainEqual({
        _tag: "text",
        key: "oauthProfileId",
        value: "account-1@cloud-1"
      })
      expect(request.values.some(({ key }) => key === "apiToken" || key === "email")).toBe(false)
    }
  })

  it("adds only the missing Atlassian product for an existing account", async () => {
    const create = vi.fn<ConnectionTestTransport["create"]>().mockRejectedValue(new Error("stop after request"))
    const transport: ConnectionTestTransport = {
      create,
      discoverAtlassianProfiles: () => Promise.resolve([]),
      overview: () => Promise.resolve(overview),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport, "/services?enable=confluence")
    await act(async () => undefined)

    const useApiToken = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Use API token instead")
    )
    await act(async () => useApiToken?.click())
    const inputs = host.querySelectorAll<HTMLInputElement>("input")
    const values = [
      "Atlassian workspace",
      "avery@example.com",
      "api-token",
      "https://team.atlassian.net/",
      "cloud-1",
      "space-1",
      "page-1"
    ]
    for (const [index, value] of values.entries()) {
      const input = inputs[index]
      if (input !== undefined) await setControlValue(input, value)
    }
    const submit = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Connect Atlassian")
    )
    await act(async () => submit?.click())

    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]?.[0].providerId).toBe("confluence")
  })

  it.each(atlassianOAuthStartCases)(
    "starts OAuth for $label and reports the exact callback setup",
    async ({ connections, providers, route }) => {
      const startAtlassianOAuthGrant = vi
        .fn<NonNullable<ConnectionTestTransport["startAtlassianOAuthGrant"]>>()
        .mockResolvedValue({
          _tag: "configuration-required",
          callbackUrl: "http://127.0.0.1:4173/services/oauth/atlassian/callback"
        })
      const transport: ConnectionTestTransport = {
        create: vi.fn(),
        discoverAtlassianProfiles: () => Promise.resolve([]),
        makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
        overview: () => Promise.resolve({ ...overview, connections }),
        setEnabled: vi.fn(),
        startAtlassianOAuthGrant,
        test: vi.fn()
      }
      const host = await renderServices(transport, route)
      await act(async () => undefined)
      const signIn = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
        textContent?.includes("Sign in with Atlassian")
      )

      await act(async () => signIn?.click())

      expect(startAtlassianOAuthGrant).toHaveBeenCalledOnce()
      expect(startAtlassianOAuthGrant.mock.calls[0]?.[0]).toEqual(providers)
      expect(startAtlassianOAuthGrant.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal)
      expect(host.textContent).toContain("OAuth needs a one-time local client configuration")
      expect(host.textContent).toContain("http://127.0.0.1:4173/services/oauth/atlassian/callback")
    }
  )

  it("cancels a pending OAuth start when the setup form closes", async () => {
    let resolveStart: ((value: AtlassianOAuthGrantStartResponse) => void) | undefined
    let startSignal: AbortSignal | undefined
    const startAtlassianOAuthGrant = vi.fn<NonNullable<ConnectionTestTransport["startAtlassianOAuthGrant"]>>(
      (_providers, signal) => {
        startSignal = signal
        return new Promise((resolve) => {
          resolveStart = resolve
        })
      }
    )
    const transport: ConnectionTestTransport = {
      create: vi.fn(),
      discoverAtlassianProfiles: () => Promise.resolve([]),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      overview: () => Promise.resolve(overview),
      setEnabled: vi.fn(),
      startAtlassianOAuthGrant,
      test: vi.fn()
    }
    const host = await renderServices(transport, "/services?enable=confluence")
    await act(async () => undefined)
    const signIn = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Sign in with Atlassian")
    )
    await act(async () => signIn?.click())
    const cancel = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Cancel")
    )
    const previousLocation = window.location.href
    await act(async () => cancel?.click())
    expect(startSignal?.aborted).toBe(true)
    await act(async () =>
      resolveStart?.({
        _tag: "ready",
        authorizationUrl: "https://auth.atlassian.com/authorize?state=unused",
        callbackUrl: "http://127.0.0.1:4173/services/oauth/atlassian/callback"
      })
    )
    expect(window.location.href).toBe(previousLocation)
  })

  it("cancels a pending OAuth start when switching to API-token mode without blocking a later redirect", async () => {
    let resolveFirstStart: ((value: AtlassianOAuthGrantStartResponse) => void) | undefined
    let firstStartSignal: AbortSignal | undefined
    const previousLocation = window.location.href
    const authorizationUrl = new URL("#atlassian-oauth-ready", previousLocation).href
    const startAtlassianOAuthGrant = vi.fn<NonNullable<ConnectionTestTransport["startAtlassianOAuthGrant"]>>(
      (_providers, signal) => {
        if (firstStartSignal === undefined) {
          firstStartSignal = signal
          return new Promise((resolve) => {
            resolveFirstStart = resolve
          })
        }
        return Promise.resolve({
          _tag: "ready",
          authorizationUrl,
          callbackUrl: "http://127.0.0.1:4173/services/oauth/atlassian/callback"
        })
      }
    )
    const transport: ConnectionTestTransport = {
      create: vi.fn(),
      discoverAtlassianProfiles: () => Promise.resolve([]),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      overview: () => Promise.resolve(overview),
      setEnabled: vi.fn(),
      startAtlassianOAuthGrant,
      test: vi.fn()
    }
    const host = await renderServices(transport, "/services?enable=confluence")
    await act(async () => undefined)
    const buttonWithText = (text: string): HTMLButtonElement | undefined =>
      [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) => textContent?.includes(text))

    await act(async () => buttonWithText("Sign in with Atlassian")?.click())
    await act(async () => buttonWithText("Use API token instead")?.click())
    expect(firstStartSignal?.aborted).toBe(true)
    await act(async () =>
      resolveFirstStart?.({
        _tag: "ready",
        authorizationUrl: new URL("#late-atlassian-oauth", previousLocation).href,
        callbackUrl: "http://127.0.0.1:4173/services/oauth/atlassian/callback"
      })
    )
    expect(window.location.href).toBe(previousLocation)

    await act(async () => buttonWithText("Use OAuth profile")?.click())
    await act(async () => buttonWithText("Sign in with Atlassian")?.click())

    expect(window.location.href).toBe(authorizationUrl)
    window.history.replaceState(null, "", previousLocation)
  })

  it("adds an intentional second Atlassian account when both products already exist", async () => {
    const connectionIds = [
      Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000163"),
      Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000164")
    ]
    const create = vi.fn<ConnectionTestTransport["create"]>(successfulCreate)
    const transport: ConnectionTestTransport = {
      create,
      discoverAtlassianProfiles: () => Promise.resolve([]),
      overview: () => Promise.resolve({ ...overview, connections: [connection, confluenceConnection] }),
      makeConnectionId: vi.fn().mockResolvedValueOnce(connectionIds[0]).mockResolvedValueOnce(connectionIds[1]),
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport)
    await act(async () => undefined)

    const jiraCard = [...host.querySelectorAll<HTMLElement>("article")].find((card) =>
      card.textContent?.includes("Payments Jira")
    )
    const addConnection = [...(jiraCard?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(({ textContent }) =>
      textContent?.includes("Add connection")
    )
    await act(async () => addConnection?.click())
    const useApiToken = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Use API token instead")
    )
    await act(async () => useApiToken?.click())
    const values = [
      "Second Atlassian account",
      "avery@example.com",
      "api-token",
      "https://second.atlassian.net/",
      "cloud-2",
      "space-2",
      "page-2"
    ]
    for (const [index, value] of values.entries()) {
      const input = host.querySelectorAll<HTMLInputElement>("input")[index]
      if (input !== undefined) await setControlValue(input, value)
    }
    const submit = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Connect Atlassian")
    )
    await act(async () => submit?.click())

    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls.map(([request]) => request.providerId)).toEqual(["jira", "confluence"])
  })

  it("adds missing Jira without requiring Confluence resource fields", async () => {
    const create = vi.fn<ConnectionTestTransport["create"]>(successfulCreate)
    const transport: ConnectionTestTransport = {
      create,
      discoverAtlassianProfiles: () => Promise.resolve([]),
      overview: () => Promise.resolve({ ...overview, connections: [confluenceConnection] }),
      makeConnectionId: () =>
        Promise.resolve(Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000165")),
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport, "/services?enable=jira")
    await act(async () => undefined)

    const useApiToken = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Use API token instead")
    )
    await act(async () => useApiToken?.click())
    expect(host.textContent).not.toContain("Site ID")
    expect(host.textContent).not.toContain("Confluence space ID")
    expect(host.textContent).not.toContain("Health page ID")
    const values = ["Jira account", "avery@example.com", "api-token", "https://team.atlassian.net/"]
    for (const [index, value] of values.entries()) {
      const input = host.querySelectorAll<HTMLInputElement>("input")[index]
      if (input !== undefined) await setControlValue(input, value)
    }
    const submit = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Connect Atlassian")
    )
    await act(async () => submit?.click())

    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]?.[0].providerId).toBe("jira")
  })

  it("keeps API-token site fields when OAuth discovery finishes later", async () => {
    let resolveProfiles:
      | ((profiles: Awaited<ReturnType<NonNullable<ConnectionTestTransport["discoverAtlassianProfiles"]>>>) => void)
      | undefined
    const profiles = new Promise<
      Awaited<ReturnType<NonNullable<ConnectionTestTransport["discoverAtlassianProfiles"]>>>
    >((resolve) => {
      resolveProfiles = resolve
    })
    const transport: ConnectionTestTransport = {
      create: vi.fn(),
      discoverAtlassianProfiles: () => profiles,
      overview: () => Promise.resolve({ ...overview, connections: [] }),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport, "/services?enable=jira")
    const useApiToken = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Use API token instead")
    )
    await act(async () => useApiToken?.click())
    const siteUrl = host.querySelector<HTMLInputElement>('input[type="url"]')
    const siteId = host.querySelectorAll<HTMLInputElement>("input")[4]
    expect(siteUrl).not.toBeNull()
    expect(siteId).toBeDefined()
    if (siteUrl !== null) await setControlValue(siteUrl, "https://manual.atlassian.net/")
    if (siteId !== undefined) await setControlValue(siteId, "manual-cloud")

    await act(async () =>
      resolveProfiles?.([
        {
          profileId: "account-1@discovered-cloud",
          name: "Discovered account",
          siteUrl: "https://discovered.atlassian.net/",
          cloudId: "discovered-cloud",
          accountName: "Avery Bell",
          accountEmail: "avery@example.com",
          status: "valid",
          providers: ["jira", "confluence"]
        }
      ])
    )

    expect(siteUrl?.value).toBe("https://manual.atlassian.net/")
    expect(siteId?.value).toBe("manual-cloud")
  })

  it("connects several repositories and pipelines through one AWS account form", async () => {
    const connectionIds = [
      Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000151"),
      Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000152"),
      Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000153")
    ]
    const field = (key: string, defaultValue: string | null = null) => ({
      key,
      label: key,
      description: `Configure ${key}.`,
      kind: "text",
      scope: "adapter",
      required: true,
      defaultValue,
      isReadOnly: false,
      minimum: null,
      maximum: null
    })
    const awsOverview = Schema.decodeUnknownSync(PluginOverviewResponse)({
      catalog: [
        {
          ...catalogEntry("codecommit"),
          configurationFields: [field("profile", "default"), field("region"), field("repositoryName")]
        },
        {
          ...catalogEntry("codepipeline"),
          configurationFields: [field("profile", "default"), field("region"), field("pipelineName")]
        },
        catalogEntry("jira"),
        catalogEntry("confluence"),
        catalogEntry("clockify")
      ],
      connections: []
    })
    const createImplementation: ConnectionTestTransport["create"] = (request) =>
      Promise.resolve(
        Schema.decodeUnknownSync(CreatePluginConnectionResponse)({
          connection: {
            pluginConnectionId: request.pluginConnectionId,
            providerId: request.providerId,
            displayName: request.displayName,
            isEnabled: true,
            health: null,
            updatedAt: "2026-07-14T10:03:00.000Z"
          },
          configuration: {
            pluginConnectionId: request.pluginConnectionId,
            revision: 1,
            values: request.values,
            updatedAt: "2026-07-14T10:03:00.000Z"
          },
          test: {
            _tag: "healthy",
            pluginConnectionId: request.pluginConnectionId,
            providerId: request.providerId,
            checkedAt: "2026-07-14T10:03:00.000Z",
            latencyMilliseconds: 20,
            identity: {
              kind: "account",
              label: "AWS account",
              displayName: "Production account",
              providerImmutableId: "123456789012"
            }
          }
        })
      )
    const create = vi.fn(createImplementation)
    const makeConnectionId = vi
      .fn()
      .mockResolvedValueOnce(connectionIds[0])
      .mockResolvedValueOnce(connectionIds[1])
      .mockResolvedValueOnce(connectionIds[2])
    const transport: ConnectionTestTransport = {
      create,
      discoverAwsProfiles: () => Promise.resolve([{ profile: "production", region: "eu-west-1" }]),
      overview: () => Promise.resolve(awsOverview),
      makeConnectionId,
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport, "/services?enable=codecommit")
    await act(async () => undefined)

    const inputs = host.querySelectorAll<HTMLInputElement>("input")
    if (inputs[0] !== undefined) await setControlValue(inputs[0], "Payments production")
    if (inputs[1] !== undefined) await setControlValue(inputs[1], "production")
    const textareas = host.querySelectorAll<HTMLTextAreaElement>("textarea")
    if (textareas[0] !== undefined) await setControlValue(textareas[0], "payments-api\nrisk-engine")
    if (textareas[1] !== undefined) await setControlValue(textareas[1], "payments-production")
    const submit = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Connect AWS account")
    )
    await act(async () => submit?.click())

    expect(create).toHaveBeenCalledTimes(3)
    expect(create.mock.calls.map(([request]) => request.providerId)).toEqual([
      "codecommit",
      "codecommit",
      "codepipeline"
    ])
    expect(create.mock.calls.map(([request]) => request.displayName)).toEqual([
      "Payments production · payments-api",
      "Payments production · risk-engine",
      "Payments production · payments-production"
    ])
    expect(
      create.mock.calls.map(
        ([request]) => request.values.find(({ key }) => key === "repositoryName" || key === "pipelineName")?.value
      )
    ).toEqual(["payments-api", "risk-engine", "payments-production"])
  })

  it("retries only AWS drafts that did not create successfully", async () => {
    const connectionIds = [
      Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000171"),
      Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000172"),
      Schema.decodeSync(PluginConnectionId)("01890f6f-6d6a-7cc0-98d2-000000000173")
    ]
    let creationAttempt = 0
    const create = vi.fn<ConnectionTestTransport["create"]>((request) => {
      creationAttempt += 1
      if (creationAttempt === 2) return Promise.reject(new Error("temporary provider failure"))
      return Promise.resolve(
        Schema.decodeUnknownSync(CreatePluginConnectionResponse)({
          connection: {
            pluginConnectionId: request.pluginConnectionId,
            providerId: request.providerId,
            displayName: request.displayName,
            isEnabled: true,
            health: null,
            updatedAt: "2026-07-14T10:03:00.000Z"
          },
          configuration: {
            pluginConnectionId: request.pluginConnectionId,
            revision: 1,
            values: request.values,
            updatedAt: "2026-07-14T10:03:00.000Z"
          },
          test: {
            _tag: "healthy",
            pluginConnectionId: request.pluginConnectionId,
            providerId: request.providerId,
            checkedAt: "2026-07-14T10:03:00.000Z",
            latencyMilliseconds: 20,
            identity: {
              kind: "account",
              label: "AWS account",
              displayName: "Production account",
              providerImmutableId: "123456789012"
            }
          }
        })
      )
    })
    const makeConnectionId = vi
      .fn()
      .mockResolvedValueOnce(connectionIds[0])
      .mockResolvedValueOnce(connectionIds[1])
      .mockResolvedValueOnce(connectionIds[2])
    const transport: ConnectionTestTransport = {
      create,
      overview: () => Promise.resolve({ ...overview, connections: [] }),
      makeConnectionId,
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport, "/services?enable=codecommit")
    await act(async () => undefined)

    const inputs = host.querySelectorAll<HTMLInputElement>("input")
    if (inputs[0] !== undefined) await setControlValue(inputs[0], "Payments production")
    if (inputs[2] !== undefined) await setControlValue(inputs[2], "eu-west-1")
    const repositories = host.querySelectorAll<HTMLTextAreaElement>("textarea")[0]
    if (repositories !== undefined) await setControlValue(repositories, "payments-api\nrisk-engine")
    const submit = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Connect AWS account")
    )
    await act(async () => submit?.click())

    expect(create.mock.calls.map(([request]) => request.displayName)).toEqual([
      "Payments production · payments-api",
      "Payments production · risk-engine"
    ])
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("could not be connected")

    await act(async () => submit?.click())

    expect(create.mock.calls.map(([request]) => request.displayName)).toEqual([
      "Payments production · payments-api",
      "Payments production · risk-engine",
      "Payments production · risk-engine"
    ])
    expect(
      create.mock.calls.filter(([request]) => request.displayName === "Payments production · payments-api")
    ).toHaveLength(1)
  })

  it("rejects an oversized AWS resource list instead of silently dropping resources", async () => {
    const create = vi.fn()
    const transport: ConnectionTestTransport = {
      create,
      overview: () => Promise.resolve({ ...overview, connections: [] }),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport, "/services?enable=codecommit")
    await act(async () => undefined)

    const region = host.querySelectorAll<HTMLInputElement>("input")[2]
    if (region !== undefined) await setControlValue(region, "eu-west-1")
    const repositories = host.querySelectorAll<HTMLTextAreaElement>("textarea")[0]
    if (repositories !== undefined) {
      await setControlValue(
        repositories,
        Array.from({ length: 21 }, (_, index) => `repository-${index + 1}`).join("\n")
      )
    }
    const submit = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Connect AWS account")
    )
    await act(async () => submit?.click())

    expect(create).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Follow at most 20 repositories")
  })

  it("does not present stale disabled health as current for an enabled connection", async () => {
    const enabledWithStaleHealth = Schema.decodeSync(PluginConnectionSummary)({
      ...Schema.encodeSync(PluginConnectionSummary)(connection),
      isEnabled: true,
      health: {
        _tag: "disabled",
        checkedAt: "2026-07-14T10:00:00.000Z"
      }
    })
    const transport: ConnectionTestTransport = {
      create: vi.fn(),
      overview: () => Promise.resolve({ ...overview, connections: [enabledWithStaleHealth] }),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport)
    await act(async () => undefined)
    const connectionCard = [...host.querySelectorAll<HTMLElement>("article")].find((card) =>
      card.textContent?.includes("Payments Jira")
    )
    expect(connectionCard?.textContent).toContain("Not checked")
    expect(connectionCard?.textContent).not.toContain("Disabled")
  })

  it("renders the fresh five, opens setup, submits, and shows the immediate identity", async () => {
    const created = Schema.decodeUnknownSync(CreatePluginConnectionResponse)({
      connection: {
        pluginConnectionId: connection.pluginConnectionId,
        providerId: "codecommit",
        displayName: "Payments CodeCommit",
        isEnabled: true,
        health: null,
        updatedAt: "2026-07-14T10:03:00.000Z"
      },
      configuration: {
        pluginConnectionId: connection.pluginConnectionId,
        revision: 1,
        values: [{ _tag: "text", key: "profile", value: "default" }],
        updatedAt: "2026-07-14T10:03:00.000Z"
      },
      test: {
        _tag: "healthy",
        pluginConnectionId: connection.pluginConnectionId,
        providerId: "codecommit",
        checkedAt: "2026-07-14T10:03:00.000Z",
        latencyMilliseconds: 42,
        identity: {
          kind: "account",
          label: "AWS account",
          displayName: "Production account",
          providerImmutableId: "123456789012"
        }
      }
    })
    const create = vi.fn().mockResolvedValue(created)
    const transport: ConnectionTestTransport = {
      create,
      overview: () => Promise.resolve({ ...overview, connections: [] }),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport)
    await act(async () => undefined)
    expect(host.querySelectorAll("article")).toHaveLength(5)

    const configure = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Configure AWS account")
    )
    await act(async () => configure?.click())
    const name = host.querySelectorAll<HTMLInputElement>("input")[0]
    expect(name).not.toBeNull()
    if (name !== undefined) await setControlValue(name, "Payments")
    const region = host.querySelectorAll<HTMLInputElement>("input")[2]
    if (region !== undefined) await setControlValue(region, "eu-west-1")
    const repositories = host.querySelectorAll<HTMLTextAreaElement>("textarea")[0]
    if (repositories !== undefined) await setControlValue(repositories, "payments-api")
    const submit = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Connect AWS account")
    )
    await act(async () => submit?.click())
    expect(create).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain("Production account")
    expect(host.textContent).toContain("123456789012")
  })

  it("keeps a correction form visible when the initial connection test fails", async () => {
    const created = Schema.decodeUnknownSync(CreatePluginConnectionResponse)({
      connection: {
        pluginConnectionId: connection.pluginConnectionId,
        providerId: "codecommit",
        displayName: "Rejected CodeCommit",
        isEnabled: true,
        health: {
          _tag: "unavailable",
          checkedAt: "2026-07-14T10:03:00.000Z",
          failureClass: "authentication",
          retryAt: null,
          safeMessage: "The provider rejected these credentials."
        },
        updatedAt: "2026-07-14T10:03:00.000Z"
      },
      configuration: {
        pluginConnectionId: connection.pluginConnectionId,
        revision: 1,
        values: [{ _tag: "text", key: "profile", value: "default" }],
        updatedAt: "2026-07-14T10:03:00.000Z"
      },
      test: {
        _tag: "failed",
        pluginConnectionId: connection.pluginConnectionId,
        providerId: "codecommit",
        checkedAt: "2026-07-14T10:03:00.000Z",
        latencyMilliseconds: 42,
        failureClass: "authentication",
        retryAt: null,
        safeMessage: "The provider rejected these credentials."
      }
    })
    const transport: ConnectionTestTransport = {
      create: vi.fn().mockResolvedValue(created),
      overview: () => Promise.resolve({ ...overview, connections: [] }),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport)
    await act(async () => undefined)
    const configure = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Configure AWS account")
    )
    await act(async () => configure?.click())
    const region = host.querySelectorAll<HTMLInputElement>("input")[2]
    if (region !== undefined) await setControlValue(region, "eu-west-1")
    const repositories = host.querySelectorAll<HTMLTextAreaElement>("textarea")[0]
    if (repositories !== undefined) await setControlValue(repositories, "payments-api")
    const submit = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Connect AWS account")
    )
    await act(async () => submit?.click())

    expect(host.textContent).toContain("The provider rejected these credentials.")
    expect(host.textContent).toContain("Needs correction")
    expect(host.textContent).toContain("Connect AWS account")
    expect(host.querySelector("form")).not.toBeNull()
  })

  it("keeps setup open and announces an inline error when creation fails", async () => {
    const transport: ConnectionTestTransport = {
      create: vi.fn().mockRejectedValue(new Error("unavailable")),
      overview: () => Promise.resolve({ ...overview, connections: [] }),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport)
    await act(async () => undefined)
    const configure = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Enable service")
    )
    await act(async () => configure?.click())
    const submit = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Enable and test")
    )
    await act(async () => submit?.click())
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("could not create")
    expect(host.textContent).toContain("Enable and test")
  })

  it("aborts an in-flight setup request when the browser session changes", async () => {
    let setupSignal: AbortSignal | undefined
    const transport: ConnectionTestTransport = {
      create: (_request, signal) => {
        setupSignal = signal
        return new Promise(() => undefined)
      },
      overview: () => Promise.resolve({ ...overview, connections: [] }),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      setEnabled: vi.fn(),
      test: vi.fn()
    }
    const host = await renderServices(transport)
    await act(async () => undefined)
    const configure = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Enable service")
    )
    await act(async () => configure?.click())
    const submit = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Enable and test")
    )
    await act(async () => submit?.click())
    await act(async () => undefined)
    expect(setupSignal?.aborted).toBe(false)
    await act(async () => sessionControls?.invalidateSession(session.sessionId))
    expect(setupSignal?.aborted).toBe(true)
    await act(async () => sessionControls?.establishSession(csrfToken, session))
    await act(async () => undefined)
    const configureAfterReconnect = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Enable service")
    )
    await act(async () => configureAfterReconnect?.click())
    const submitAfterReconnect = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Enable and test")
    )
    expect(submitAfterReconnect?.disabled).toBe(false)
  })

  it("shows testing, failure, retry, and the provider identity returned by success", async () => {
    const failed = Schema.decodeSync(PluginConnectionTestResult)({
      _tag: "failed",
      pluginConnectionId: connection.pluginConnectionId,
      providerId: "jira",
      checkedAt: "2026-07-14T10:02:00.000Z",
      latencyMilliseconds: 250,
      failureClass: "authentication",
      retryAt: null,
      safeMessage: "The provider rejected these credentials."
    })
    const healthy = Schema.decodeSync(PluginConnectionTestResult)({
      _tag: "healthy",
      pluginConnectionId: connection.pluginConnectionId,
      providerId: "jira",
      checkedAt: "2026-07-14T10:03:00.000Z",
      latencyMilliseconds: 84,
      identity: {
        kind: "user",
        label: "Atlassian user",
        displayName: "Avery Bell",
        providerImmutableId: "atlassian-account-123"
      }
    })
    let finishFirst: ((result: PluginConnectionTestResult) => void) | undefined
    const first = new Promise<PluginConnectionTestResult>((resolve) => {
      finishFirst = resolve
    })
    const test = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce(healthy)
    const transport: ConnectionTestTransport = {
      create: vi.fn(),
      overview: () => Promise.resolve(overview),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      setEnabled: vi.fn(),
      test
    }
    const host = await renderServices(transport)
    await act(async () => undefined)

    const serviceMark = host.querySelector('[data-rly-service="jira"]')
    expect(serviceMark?.getAttribute("aria-label")).toBe("Jira")

    const action = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) =>
      textContent?.includes("Test connection")
    )
    expect(action).toBeDefined()
    await act(async () => action?.click())
    expect(action?.disabled).toBe(true)

    await act(async () => finishFirst?.(failed))
    expect(host.textContent).toContain("The provider rejected these credentials.")
    expect(action?.textContent).toContain("Retry test")

    await act(async () => action?.click())
    expect(test).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain("Connection healthy")
    expect(host.textContent).toContain("Atlassian user")
    expect(host.textContent).toContain("Avery Bell")
    expect(host.textContent).toContain("atlassian-account-123")
    expect(host.textContent).toContain("84 ms")
  })

  it("enables and tests a disabled connection, then lets the owner disable it again", async () => {
    const disabled = Schema.decodeSync(PluginConnectionSummary)({
      ...Schema.encodeSync(PluginConnectionSummary)(connection),
      isEnabled: false,
      health: {
        _tag: "healthy",
        checkedAt: "2026-07-14T10:00:00.000Z"
      }
    })
    const healthy = Schema.decodeSync(PluginConnectionTestResult)({
      _tag: "healthy",
      pluginConnectionId: connection.pluginConnectionId,
      providerId: "jira",
      checkedAt: "2026-07-14T10:03:00.000Z",
      latencyMilliseconds: 84,
      identity: {
        kind: "user",
        label: "Atlassian user",
        displayName: "Avery Bell",
        providerImmutableId: "atlassian-account-123"
      }
    })
    const setEnabled = vi.fn((pluginConnectionId, isEnabled) =>
      Promise.resolve(
        Schema.decodeSync(PluginConnectionSummary)({
          ...Schema.encodeSync(PluginConnectionSummary)(disabled),
          pluginConnectionId,
          isEnabled,
          updatedAt: "2026-07-14T10:04:00.000Z"
        })
      )
    )
    const test = vi.fn().mockResolvedValue(healthy)
    const transport: ConnectionTestTransport = {
      create: vi.fn(),
      overview: () => Promise.resolve({ ...overview, connections: [disabled] }),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      setEnabled,
      test
    }
    const host = await renderServices(transport)
    await act(async () => undefined)
    const connectionCard = [...host.querySelectorAll<HTMLElement>("article")].find((card) =>
      card.textContent?.includes("Payments Jira")
    )
    expect(connectionCard?.textContent).toContain("Disabled")
    expect(connectionCard?.textContent).not.toContain("Healthy")

    const enable = [...(connectionCard?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(({ textContent }) =>
      textContent?.includes("Enable service")
    )
    await act(async () => enable?.click())
    expect(setEnabled).toHaveBeenLastCalledWith(connection.pluginConnectionId, true, expect.any(AbortSignal))
    expect(test).toHaveBeenCalledWith(connection.pluginConnectionId, expect.any(AbortSignal))
    expect(connectionCard?.textContent).toContain("Connection healthy")

    const disable = [...(connectionCard?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(({ textContent }) =>
      textContent?.includes("Disable")
    )
    await act(async () => disable?.click())
    expect(setEnabled).toHaveBeenLastCalledWith(connection.pluginConnectionId, false, expect.any(AbortSignal))
    expect(connectionCard?.textContent).toContain("Disabled")
    expect(connectionCard?.textContent).not.toContain("Connection healthy")
  })

  it("recovers the test action when disabling aborts a test but the mutation fails", async () => {
    let testSignal: AbortSignal | undefined
    const transport: ConnectionTestTransport = {
      create: vi.fn(),
      overview: () => Promise.resolve(overview),
      makeConnectionId: () => Promise.resolve(connection.pluginConnectionId),
      setEnabled: vi.fn().mockRejectedValue(new Error("conflict")),
      test: (_pluginConnectionId, signal) => {
        testSignal = signal
        return new Promise(() => undefined)
      }
    }
    const host = await renderServices(transport)
    await act(async () => undefined)
    const connectionCard = [...host.querySelectorAll<HTMLElement>("article")].find((card) =>
      card.textContent?.includes("Payments Jira")
    )
    const test = [...(connectionCard?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(({ textContent }) =>
      textContent?.includes("Test connection")
    )
    await act(async () => test?.click())
    expect(testSignal?.aborted).toBe(false)

    const disable = [...(connectionCard?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(({ textContent }) =>
      textContent?.includes("Disable")
    )
    await act(async () => disable?.click())
    expect(testSignal?.aborted).toBe(true)
    expect(connectionCard?.textContent).toContain("could not change this service")
    const recoveredTest = [...(connectionCard?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      ({ textContent }) => textContent?.includes("Test connection")
    )
    expect(recoveredTest?.disabled).toBe(false)
  })
})
