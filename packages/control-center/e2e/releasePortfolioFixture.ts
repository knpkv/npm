import * as Schema from "effect/Schema"

import { PortfolioSnapshot } from "../src/api/portfolio.js"

/** One Schema-decoded release snapshot for route-level browser acceptance. */
export const releasePortfolioFixture = Schema.decodeUnknownSync(PortfolioSnapshot)({
  eventCursor: 10,
  generatedAt: "2026-07-14T10:16:00.000Z",
  plugins: [
    {
      displayName: "Payments Jira",
      health: { _tag: "healthy", checkedAt: "2026-07-14T10:04:00.000Z" },
      isEnabled: true,
      pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000091",
      providerId: "jira",
      updatedAt: "2026-07-14T10:15:00.000Z"
    }
  ],
  releases: [
    {
      collaboratorCount: 2,
      collaborators: [
        {
          avatarFallback: "AB",
          displayName: "Avery Bell",
          personId: "01890f6f-6d6a-7cc0-98d2-000000000021",
          role: "release-owner"
        },
        {
          avatarFallback: "MS",
          displayName: "Mara Singh",
          personId: "01890f6f-6d6a-7cc0-98d2-000000000022",
          role: "release-approver"
        }
      ],
      freshness: {
        _tag: "current",
        pluginHealth: { _tag: "healthy", checkedAt: "2026-07-14T10:04:00.000Z" },
        provenance: {
          _tag: "provider",
          sourceRevision: {
            firstObservedAt: "2026-07-14T10:00:00.000Z",
            lastObservedAt: "2026-07-14T10:02:00.000Z",
            normalizationSchemaVersion: 1,
            pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000091",
            providerId: "jira",
            revision: "jira-revision-7",
            sourceUrl: null,
            synchronizedAt: "2026-07-14T10:03:00.000Z",
            vendorImmutableId: "release-payments-2.18.0"
          }
        },
        sourceObservedAt: "2026-07-14T10:02:00.000Z",
        staleAfterSeconds: 300,
        synchronizedAt: "2026-07-14T10:03:00.000Z"
      },
      lifecycle: "candidate",
      relay: { algorithm: "relay/v1", codename: "Copper Finch", symbolIndices: [6, 3, 7] },
      releaseId: "01890f6f-6d6a-7cc0-98d2-000000000011",
      serviceName: "payments-api",
      sourceRevisionCount: 1,
      targetEnvironmentIds: ["01890f6f-6d6a-7cc0-98d2-000000000031"],
      updatedAt: "2026-07-14T10:03:00.000Z",
      version: "2.18.0-rc.1"
    }
  ],
  workspaceId: "01890f6f-6d6a-7cc0-98d2-000000000001"
})
