import { PortalProvider, ThemeProvider } from "@knpkv/rly/foundations"
import * as Schema from "effect/Schema"
import type { ReactElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"
import { assert, describe, expect, it, vi } from "@effect/vitest"

import { SessionSummary } from "../../src/api/session.js"
import {
  PluginConnectionAdministration,
  PluginConnectionTestResult,
  PluginSynchronizationState
} from "../../src/api/plugins.js"
import { ConnectionAdministration } from "../../src/client/services/ConnectionAdministration.js"
import { ConnectionTestEvidence } from "../../src/client/services/ConnectionTestEvidence.js"
import { DEFAULT_WORKSPACE_SETTINGS } from "../../src/domain/workspaceSettings.js"
import {
  BrowserSessionStatusView,
  ConnectionSynchronizationView,
  PortfolioOverviewView,
  RelationshipRepairPanelView,
  ReleaseEvidence,
  SettingsForm
} from "../../src/views.js"
import { presentPortfolio } from "../../src/client/portfolio/presentPortfolio.js"
import { makePortfolioSnapshot } from "./portfolioFixtures.js"

const snapshot = makePortfolioSnapshot()
const portfolio = presentPortfolio(snapshot)
const release = portfolio.releases[0]
assert.isDefined(release)
const session = Schema.decodeUnknownSync(SessionSummary)({
  sessionId: "01890f6f-6d6a-7cc0-98d2-000000000092",
  workspaceId: snapshot.workspaceId,
  actor: { _tag: "human", personId: "01890f6f-6d6a-7cc0-98d2-000000000022" },
  permission: "workspace-approver",
  createdAt: "2026-07-14T09:00:00.000Z",
  lastSeenAt: "2026-07-14T10:00:00.000Z",
  idleExpiresAt: "2026-07-14T11:00:00.000Z",
  absoluteExpiresAt: "2026-07-15T09:00:00.000Z",
  revokedAt: null
})

/** Use only the documented host providers, without session, transports or application theme storage. */
const renderView = (view: ReactElement): string =>
  renderToStaticMarkup(
    <ThemeProvider theme="light">
      <MemoryRouter>
        <PortalProvider>{view}</PortalProvider>
      </MemoryRouter>
    </ThemeProvider>
  )

describe("controlled views", () => {
  it("renders a portfolio and supplied session badge without a browser session provider", () => {
    const markup = renderView(
      <PortfolioOverviewView
        onPreviewRelease={vi.fn()}
        onRetry={vi.fn()}
        sessionStatus={<span>Host session badge</span>}
        state={{
          _tag: "ready",
          connection: { _tag: "connected" },
          isSnapshotStale: false,
          portfolio: presentPortfolio(makePortfolioSnapshot("connected-empty"))
        }}
      />
    )
    expect(markup).toContain("No releases yet")
    expect(markup).toContain("Host session badge")
    expect(markup).not.toContain("Browser not paired")
  })

  it("renders the repair ledger from explicit session and decision state", () => {
    const markup = renderView(
      <RelationshipRepairPanelView
        mutationsEnabled={false}
        onApply={vi.fn(async () => true)}
        onRetry={vi.fn()}
        onReview={vi.fn(async () => true)}
        release={release}
        session={session}
        state={{
          _tag: "ready",
          actionFailure: null,
          applications: new Map(),
          busyProposalId: null,
          environmentScopeKey: "",
          releaseId: release.id,
          sessionKey: session.sessionId,
          page: {
            releaseId: release.id,
            environmentId: null,
            status: null,
            truncated: false,
            proposals: [],
            applications: []
          }
        }}
      />
    )
    expect(markup).toContain("No repair decisions")
  })

  it("renders disabled settings fields from an explicit draft without the application providers", () => {
    const markup = renderView(<SettingsForm canEdit={false} draft={DEFAULT_WORKSPACE_SETTINGS} onChange={vi.fn()} />)
    expect(markup).toContain("Allowed providers")
    expect(markup).toContain('disabled=""')
    expect(markup).toContain("Release targets")
  })

  it("renders source evidence from the supplied release", () => {
    const markup = renderView(
      <ReleaseEvidence
        release={{
          ...release,
          source: {
            ...release.source,
            displayName: "Fixture source",
            warning: "Preserved fixture evidence."
          }
        }}
      />
    )
    expect(markup).toContain("Fixture source")
    expect(markup).toContain("Preserved fixture evidence.")
  })

  it("renders permission and storage presentations without session credentials", () => {
    expect(
      renderView(<BrowserSessionStatusView presentation={{ _tag: "authenticated", permission: "workspace-owner" }} />)
    ).toContain("Owner browser paired")
    expect(
      renderView(<BrowserSessionStatusView presentation={{ _tag: "storage-unavailable", paired: true }} />)
    ).toContain("Browser paired, but session storage is unavailable.")
  })

  it("uses the supplied reference time for synchronization age", () => {
    const synchronization = Schema.decodeUnknownSync(PluginSynchronizationState)({
      pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000091",
      providerId: "jira",
      streamKey: "fixture",
      lastAttemptAt: "2026-07-14T10:00:00.000Z",
      lastSuccessAt: "2026-07-14T10:00:00.000Z",
      result: "synchronized",
      pagesCommitted: 1,
      failure: null
    })
    const viewAt = (now: Date) =>
      renderView(
        <ConnectionSynchronizationView
          canSynchronize
          now={now}
          onRefresh={vi.fn()}
          onSynchronize={vi.fn()}
          state={{ _tag: "ready", synchronization }}
        />
      )
    expect(viewAt(new Date("2026-07-14T10:02:00.000Z"))).toContain("Synced 2 min ago")
    expect(viewAt(new Date("2026-07-14T10:07:00.000Z"))).toContain("Synced 7 min ago")
  })

  // A connection card reads like the Overview's Sources panel: "14 Jul 2026, 10:00 UTC", never ISO text.
  it("shows connection test and sync times as readable UTC times", () => {
    const pluginConnectionId = "01890f6f-6d6a-7cc0-98d2-000000000091"
    const result = Schema.decodeUnknownSync(PluginConnectionTestResult)({
      _tag: "healthy",
      pluginConnectionId,
      providerId: "jira",
      checkedAt: "2026-07-14T10:00:00.000Z",
      latencyMilliseconds: 12,
      identity: { kind: "user", label: "Atlassian user", displayName: "Release Owner", providerImmutableId: "owner" }
    })
    const evidence = renderView(<ConnectionTestEvidence state={{ _tag: "result", result }} />)
    expect(evidence).toContain('Checked <time dateTime="2026-07-14T10:00:00.000Z">14 Jul 2026, 10:00 UTC</time>')

    const administration = Schema.decodeUnknownSync(PluginConnectionAdministration)({
      connection: {
        pluginConnectionId,
        providerId: "jira",
        displayName: "Release Jira",
        isEnabled: true,
        health: null,
        updatedAt: "2026-07-14T10:00:00.000Z"
      },
      configuration: { pluginConnectionId, revision: 1, values: [], updatedAt: "2026-07-14T10:00:00.000Z" },
      metadata: {
        pluginConnectionId,
        pluginId: "dev.knpkv.jira.read",
        contractVersion: { major: 1, minor: 0, patch: 0 },
        adapterVersion: { major: 1, minor: 0, patch: 0 },
        configurationFields: [],
        capabilities: []
      },
      credentialFields: [],
      permissions: [],
      schedule: { mode: "manual", nextRunAt: null },
      synchronization: {
        pluginConnectionId,
        providerId: "jira",
        streamKey: "fixture",
        lastAttemptAt: "2026-07-14T10:00:00.000Z",
        lastSuccessAt: "2026-07-14T10:00:00.000Z",
        result: "synchronized",
        pagesCommitted: 1,
        failure: null
      },
      diagnostics: []
    })
    const card = renderView(
      <ConnectionAdministration
        canConfigure
        onReauthorize={() => Promise.resolve(true)}
        onRevoke={() => Promise.resolve(true)}
        onStartAtlassianOAuth={undefined}
        state={{ _tag: "ready", administration }}
      />
    )
    expect(card).toContain(
      'Last successful sync <time dateTime="2026-07-14T10:00:00.000Z">14 Jul 2026, 10:00 UTC</time>'
    )
    expect(card).not.toContain("DateTime")
    // Nothing negotiated: no intro line above the empty-state sentence.
    expect(card).toContain("No provider operations were negotiated.")
    expect(card).not.toContain("What Control Center does with this connection.")

    const turnedOff = renderView(
      <ConnectionAdministration
        canConfigure
        onReauthorize={() => Promise.resolve(true)}
        onRevoke={() => Promise.resolve(true)}
        onStartAtlassianOAuth={undefined}
        state={{
          _tag: "ready",
          administration: {
            ...administration,
            connection: { ...administration.connection, isEnabled: false },
            permissions: [
              { capabilityId: "entity.read", version: 1, state: "disabled" },
              { capabilityId: "sync.incremental", version: 1, state: "disabled" }
            ]
          }
        }}
      />
    )
    expect(turnedOff).toContain("What Control Center does with this connection.")
    expect(turnedOff).toContain("Read items, sync changes")
    expect(turnedOff).toContain("Paused while this connection is turned off.")
    expect(turnedOff).not.toContain("Turned off</dt>")
  })
})
