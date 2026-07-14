import {
  EnvironmentId,
  PersonId,
  PluginConnectionId,
  ReleaseId,
  RoleAssignmentId,
  WorkspaceId
} from "../src/domain/identifiers.js"
import type { FakePluginScenario } from "../src/server/plugins/fake/FakePluginScenario.js"
import { fakeSyncScriptKey } from "../src/server/plugins/fake/FakePluginScenario.js"

export const REAL_WORKSPACE_ID = WorkspaceId.make("01890f6f-6d6a-7cc0-98d2-000000000071")
export const REAL_OWNER_ID = PersonId.make("01890f6f-6d6a-7cc0-98d2-000000000072")
export const REAL_PLUGIN_ID = PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000073")
export const REAL_RELEASE_ID = ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000074")
const REAL_APPROVER_ID = PersonId.make("01890f6f-6d6a-7cc0-98d2-000000000075")
const REAL_ENVIRONMENT_ID = EnvironmentId.make("01890f6f-6d6a-7cc0-98d2-000000000076")
const REAL_OWNER_ASSIGNMENT_ID = RoleAssignmentId.make("01890f6f-6d6a-7cc0-98d2-000000000077")
const REAL_APPROVER_ASSIGNMENT_ID = RoleAssignmentId.make("01890f6f-6d6a-7cc0-98d2-000000000078")

export const REAL_FIXTURE_TIME_INPUT = "2026-07-14T12:00:00.000Z"
const REAL_HEALTH_TIME_INPUT = "2026-07-14T12:02:00.000Z"
export const INITIAL_RELEASE_VERSION = "2.18.0-rc.1"
export const UPDATED_RELEASE_VERSION = "2.18.1-rc.1"

export const realFakeDescriptor = {
  contractId: "dev.knpkv.control-center.plugin",
  contractVersion: { major: 1, minor: 0, patch: 0 },
  pluginId: "dev.knpkv.fake-jira",
  adapterVersion: { major: 0, minor: 1, patch: 0 },
  displayName: "Deterministic Jira",
  configurationFields: [],
  capabilities: [{ capabilityId: "sync.incremental", supportedVersions: [1], requirement: "required" }]
}

const releaseAttributes = (version: string) => ({
  releaseId: REAL_RELEASE_ID,
  serviceName: "payments-api",
  version,
  lifecycle: "candidate",
  targetEnvironmentIds: [REAL_ENVIRONMENT_ID],
  staleAfterSeconds: 31_536_000,
  collaborators: [
    {
      personId: REAL_OWNER_ID,
      assignmentId: REAL_OWNER_ASSIGNMENT_ID,
      vendorPersonId: "ada",
      role: "release-owner"
    },
    {
      personId: REAL_APPROVER_ID,
      assignmentId: REAL_APPROVER_ASSIGNMENT_ID,
      vendorPersonId: "grace",
      role: "release-approver"
    }
  ]
})

const initialReleasePage = {
  checkpointAfterPage: "checkpoint-1",
  hasMore: false,
  events: [
    {
      _tag: "UpsertEntity",
      eventId: "release-event-1",
      observedAt: REAL_FIXTURE_TIME_INPUT,
      revision: "release-r1",
      entityType: "release",
      vendorImmutableId: "provider-release-42",
      sourceUrl: "https://jira.example/releases/42",
      title: "Payments 2.18.0",
      attributes: releaseAttributes(INITIAL_RELEASE_VERSION)
    },
    {
      _tag: "UpsertPerson",
      eventId: "person-1",
      observedAt: REAL_FIXTURE_TIME_INPUT,
      revision: "person-r1",
      vendorPersonId: "ada",
      displayName: "Ada Lovelace",
      avatarUrl: null,
      active: true
    },
    {
      _tag: "UpsertPerson",
      eventId: "person-2",
      observedAt: REAL_FIXTURE_TIME_INPUT,
      revision: "person-r1",
      vendorPersonId: "grace",
      displayName: "Grace Hopper",
      avatarUrl: null,
      active: true
    }
  ]
}

const updatedReleasePage = {
  checkpointAfterPage: "checkpoint-2",
  hasMore: false,
  events: [
    {
      _tag: "UpsertEntity",
      eventId: "release-event-2",
      observedAt: "2026-07-14T12:01:00.000Z",
      revision: "release-r2",
      entityType: "release",
      vendorImmutableId: "provider-release-42",
      sourceUrl: "https://jira.example/releases/42",
      title: "Payments 2.18.1",
      attributes: releaseAttributes(UPDATED_RELEASE_VERSION)
    }
  ]
}

/** Two-page incremental provider script: startup state followed by one live update. */
export const realFakeScenario: FakePluginScenario = {
  descriptor: realFakeDescriptor,
  discover: { _tag: "outage" },
  health: { _tag: "success", value: { _tag: "healthy", checkedAt: REAL_HEALTH_TIME_INPUT } },
  sync: {
    [fakeSyncScriptKey("releases", null)]: [{ _tag: "success", value: initialReleasePage }],
    [fakeSyncScriptKey("releases", "checkpoint-1")]: [{ _tag: "success", value: updatedReleasePage }]
  },
  readEntity: { _tag: "outage" },
  proposeAction: { _tag: "outage" },
  preflight: { _tag: "outage" },
  executeAuthorizedAction: { _tag: "outage" },
  requestCancellation: { _tag: "outage" },
  reconcile: {}
}
