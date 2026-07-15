import * as LibsqlMigrator from "@effect/sql-libsql/LibsqlMigrator"
import { migration0001Core } from "./0001_core.js"
import { migration0002Integrity } from "./0002_integrity.js"
import { migration0003Auth } from "./0003_auth.js"
import { migration0004PluginRuntime } from "./0004_plugin_runtime.js"
import { migration0005PluginConfiguration } from "./0005_plugin_configuration.js"
import { migration0006PluginSyncPageEvidence } from "./0006_plugin_sync_page_evidence.js"
import { migration0007DomainEvents } from "./0007_domain_events.js"
import { migration0008DeliveryGraph } from "./0008_delivery_graph.js"
import { migration0009Readiness } from "./0009_readiness.js"
import { migration0010ReadinessHeadHistory } from "./0010_readiness_head_history.js"
import { migration0011GovernedActions } from "./0011_governed_actions.js"
import { migration0012GovernedActionDenialPolicyOwnership } from "./0012_governed_action_denial_policy_ownership.js"
import { migration0013GovernedActionExecution } from "./0013_governed_action_execution.js"

/** Private table recording the exact ordered Control Center migration ledger. */
export const MIGRATION_LEDGER_TABLE = "control_center_migrations"

/** Exact migration ledger supported by this build. */
export const EXPECTED_MIGRATIONS = [
  { id: 1, name: "core_heads" },
  { id: 2, name: "integrity_blobs" },
  { id: 3, name: "auth" },
  { id: 4, name: "plugin_runtime" },
  { id: 5, name: "plugin_configuration" },
  { id: 6, name: "plugin_sync_page_evidence" },
  { id: 7, name: "domain_events" },
  { id: 8, name: "delivery_graph" },
  { id: 9, name: "readiness" },
  { id: 10, name: "readiness_head_history" },
  { id: 11, name: "governed_actions" },
  { id: 12, name: "governed_action_denial_policy_ownership" },
  { id: 13, name: "governed_action_execution" }
]

/** Ordered, forward-only Control Center migrations. */
export const migrationLoader = LibsqlMigrator.fromRecord({
  "0001_core_heads": migration0001Core,
  "0002_integrity_blobs": migration0002Integrity,
  "0003_auth": migration0003Auth,
  "0004_plugin_runtime": migration0004PluginRuntime,
  "0005_plugin_configuration": migration0005PluginConfiguration,
  "0006_plugin_sync_page_evidence": migration0006PluginSyncPageEvidence,
  "0007_domain_events": migration0007DomainEvents,
  "0008_delivery_graph": migration0008DeliveryGraph,
  "0009_readiness": migration0009Readiness,
  "0010_readiness_head_history": migration0010ReadinessHeadHistory,
  "0011_governed_actions": migration0011GovernedActions,
  "0012_governed_action_denial_policy_ownership": migration0012GovernedActionDenialPolicyOwnership,
  "0013_governed_action_execution": migration0013GovernedActionExecution
})
