import { defineModule, type ModuleDestination } from "@knpkv/hub-app"

/** The module contract moved to @knpkv/hub-app; re-exported for one release. */
export {
  defineModule,
  ModuleDescriptor,
  type ModuleDestination,
  ModuleListener,
  ModuleRegistrationError,
  moduleRegistryFingerprint,
  validateModuleRegistry
} from "@knpkv/hub-app"

export const fleetModule = defineModule({
  id: "fleet",
  label: "Fleet",
  defaultPage: "approvals",
  pages: [
    { id: "approvals", label: "Approvals" },
    { id: "connect", label: "Connect" },
    { id: "work", label: "Work" },
    { id: "usage", label: "Usage" }
  ],
  listeners: ["serve", "local"],
  requires: ["read", "write"]
})

export type FleetModuleDestination = ModuleDestination<typeof fleetModule>

/** Canonical Fleet keeps decisions and work; standalone Fleet retains its legacy four-page descriptor. */
export const fleetHubModule = defineModule({
  ...fleetModule,
  pages: [{ id: "approvals", label: "Approvals" }, { id: "work", label: "Work" }]
})

/** Connect is the agent home; Fleet's standalone /connect/ owner retains stage and terminal authority. */
export const connectModule = defineModule({
  id: "connect",
  label: "Connect",
  defaultPage: "overview",
  pages: [{ id: "overview", label: "Connect" }],
  listeners: ["serve", "local"],
  requires: ["read", "write"]
})

export const todayModule = defineModule({
  id: "today",
  label: "Today",
  defaultPage: "overview",
  pages: [{ id: "overview", label: "Today" }],
  listeners: ["serve", "local"],
  requires: ["read"]
})

/**
 * Where the Usage app (`@knpkv/herdr-usage`) lives, for links from core modules. Usage is no longer one of the hub's
 * own modules: an installed app with this id provides it, and the registry no longer reserves the id.
 */
export const usageModule = defineModule({
  id: "usage",
  label: "Usage",
  defaultPage: "limits",
  pages: [{ id: "limits", label: "Limits" }, { id: "tokens", label: "Tokens" }, { id: "by-tool", label: "By tool" }],
  listeners: ["serve", "local"],
  requires: ["read"]
})

/** Code reads are credential-host local; peer and Relay transports never carry its content. */
export const codeModule = defineModule({
  id: "code",
  label: "Code",
  defaultPage: "pull-requests",
  pages: [{ id: "pull-requests", label: "Pull requests" }, { id: "reviews", label: "Reviews" }, {
    id: "diffs",
    label: "Diffs"
  }],
  listeners: ["serve", "local"],
  requires: ["read"]
})

/**
 * Alchemy stacks read on the configured credential host only (`RELAY_STACKS_HOST`). Read-only: actions are
 * links to their GitHub runs and reviews; no peer or Relay transport carries provider data.
 */
export const stacksModule = defineModule({
  id: "stacks",
  label: "Stacks",
  defaultPage: "overview",
  pages: [{ id: "overview", label: "Overview" }, { id: "stack", label: "Stack" }],
  listeners: ["serve", "local"],
  requires: ["read"]
})

/**
 * Sandbox pool reads on the configured host only (`RELAY_SANDBOXES_HOST`), and only when that host's
 * configuration carries the pool. Lease, reset and budget-lift stay Fleet jobs. No peer transport.
 */
export const sandboxesModule = defineModule({
  id: "sandboxes",
  label: "Sandboxes",
  defaultPage: "overview",
  pages: [
    { id: "overview", label: "Overview" },
    { id: "account", label: "Account" },
    { id: "runs", label: "Runs" }
  ],
  listeners: ["serve", "local"],
  requires: ["read"]
})

/** Local host observations only; no operational actions or peer aggregation. */
export const resourcesModule = defineModule({
  id: "resources",
  label: "Host resources",
  defaultPage: "overview",
  pages: [{ id: "overview", label: "Host resources" }],
  listeners: ["serve", "local"],
  requires: ["read"]
})

/**
 * The ids of the hub's own modules, which no installed app may take. An embedding can add more; the hub's registry
 * refuses those too, so this list is what the CLI checks before it installs anything.
 */
export const builtInModuleIds: ReadonlyArray<string> = [
  fleetModule,
  connectModule,
  todayModule,
  codeModule,
  stacksModule,
  sandboxesModule,
  resourcesModule
].map((module) => module.id)
