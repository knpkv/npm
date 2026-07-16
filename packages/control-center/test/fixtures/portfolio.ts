import * as Schema from "effect/Schema"

import { PortfolioSnapshot } from "../../src/api/portfolio.js"
import { ReleaseId } from "../../src/domain/identifiers.js"
import { deriveReleaseRelay } from "../../src/domain/releaseRelay.js"

const releaseId = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000011")

/** Small Schema-decoded portfolio shared by Node-side API and application tests. */
export const makeNodePortfolioSnapshot = (): PortfolioSnapshot =>
  Schema.decodeUnknownSync(PortfolioSnapshot)({
    eventCursor: 10,
    generatedAt: "2026-07-14T10:16:00.000Z",
    plugins: [],
    releases: [{
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
      readiness: null,
      relationships: { issues: 0, pullRequests: 0, pipelineExecutions: 0, truncated: false },
      freshness: {
        _tag: "missing",
        pluginHealth: { _tag: "healthy", checkedAt: "2026-07-14T10:04:00.000Z" },
        provenance: {
          _tag: "none",
          pluginConnectionId: "01890f6f-6d6a-7cc0-98d2-000000000091"
        },
        sourceObservedAt: null,
        staleAfterSeconds: 300,
        synchronizedAt: "2026-07-14T10:03:00.000Z"
      },
      lifecycle: "candidate",
      relay: deriveReleaseRelay(releaseId),
      releaseId,
      serviceName: "payments-api",
      sourceRevisionCount: 1,
      targetEnvironmentIds: ["01890f6f-6d6a-7cc0-98d2-000000000031"],
      updatedAt: "2026-07-14T10:03:00.000Z",
      version: "2.18.0-rc.1"
    }],
    workspaceId: "01890f6f-6d6a-7cc0-98d2-000000000001"
  })
