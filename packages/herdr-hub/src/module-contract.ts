import { Result, Schema } from "effect"

const Segment = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/))
const Label = Schema.String.check(Schema.isMinLength(1))

export const ModuleListener = Schema.Literals(["serve", "approval", "tailnet", "lan"])
export type ModuleListener = typeof ModuleListener.Type

/** Shared metadata. `requires` describes UI capabilities; the server mount enforces access. */
export const ModuleDescriptor = Schema.Struct({
  id: Segment,
  label: Label,
  defaultPage: Segment,
  pages: Schema.Array(Schema.Struct({
    id: Segment,
    label: Label,
    showInPhoneTitle: Schema.optionalKey(Schema.Boolean)
  })).check(Schema.isMinLength(1)),
  listeners: Schema.Array(ModuleListener).check(Schema.isMinLength(1)),
  requires: Schema.Array(Schema.Literals(["read", "write"]))
})
export type ModuleDescriptor = typeof ModuleDescriptor.Type

export class ModuleRegistrationError extends Schema.TaggedError<ModuleRegistrationError>()("ModuleRegistrationError", {
  module: Schema.String,
  reason: Schema.Literals([
    "invalid_descriptor",
    "duplicate_module",
    "duplicate_page",
    "missing_default",
    "server_mismatch",
    "browser_mismatch",
    "invalid_route",
    "duplicate_route"
  ])
}) {}

/** Reject ambiguous namespaces and missing pages before a browser or server registry is used. */
export const validateModuleRegistry = (
  input: ReadonlyArray<ModuleDescriptor>
): Result.Result<ReadonlyArray<ModuleDescriptor>, ModuleRegistrationError> => {
  const decoded = Schema.decodeUnknownResult(Schema.Array(ModuleDescriptor))(input)
  if (Result.isFailure(decoded)) {
    return Result.fail(new ModuleRegistrationError({ module: "registry", reason: "invalid_descriptor" }))
  }
  const modules = new Set<string>()
  for (const descriptor of decoded.success) {
    if (modules.has(descriptor.id)) {
      return Result.fail(new ModuleRegistrationError({ module: descriptor.id, reason: "duplicate_module" }))
    }
    modules.add(descriptor.id)
    const pages = new Set<string>()
    for (const page of descriptor.pages) {
      if (pages.has(page.id)) {
        return Result.fail(new ModuleRegistrationError({ module: descriptor.id, reason: "duplicate_page" }))
      }
      pages.add(page.id)
    }
    if (!pages.has(descriptor.defaultPage)) {
      return Result.fail(new ModuleRegistrationError({ module: descriptor.id, reason: "missing_default" }))
    }
  }
  return Result.succeed(decoded.success)
}

/** Retains literal page identities. Registration validates this metadata before mounting it. */
export const defineModule = <const D extends ModuleDescriptor>(descriptor: D): D => descriptor

/** Each page belongs to its descriptor; query parameters select objects inside the owning page. */
export type ModuleDestination<D extends ModuleDescriptor = ModuleDescriptor> = D extends ModuleDescriptor
  ? { readonly module: D["id"]; readonly page: D["pages"][number]["id"] }
  : never

/** Compare complete registrations across separate bundles without relying on object identity. */
export const moduleRegistryFingerprint = (descriptors: ReadonlyArray<ModuleDescriptor>): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Array(ModuleDescriptor)))(
    descriptors
      .map((descriptor) => ({
        ...descriptor,
        pages: [...descriptor.pages].sort((a, b) => a.id.localeCompare(b.id)),
        listeners: [...descriptor.listeners].sort(),
        requires: [...descriptor.requires].sort()
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  )

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
  listeners: ["serve"],
  requires: ["read", "write"]
})

export type FleetModuleDestination = ModuleDestination<typeof fleetModule>

/** Canonical Fleet keeps decisions and work; standalone Fleet retains its legacy four-page descriptor. */
export const fleetHubModule = defineModule({
  ...fleetModule,
  pages: [{ id: "approvals", label: "Approvals", showInPhoneTitle: true }, {
    id: "work",
    label: "Work",
    showInPhoneTitle: true
  }]
})

/** Connect is the agent home; Fleet's standalone /connect/ owner retains stage and terminal authority. */
export const connectModule = defineModule({
  id: "connect",
  label: "Connect",
  defaultPage: "overview",
  pages: [{ id: "overview", label: "Connect" }],
  listeners: ["serve"],
  requires: ["read", "write"]
})

export const todayModule = defineModule({
  id: "today",
  label: "Today",
  defaultPage: "overview",
  pages: [{ id: "overview", label: "Today" }],
  listeners: ["serve"],
  requires: ["read"]
})

/** Usage details reads the existing Fleet reports; it grants no action capability. */
export const usageModule = defineModule({
  id: "usage",
  label: "Usage",
  defaultPage: "limits",
  pages: [{ id: "limits", label: "Limits", showInPhoneTitle: true }, { id: "tokens", label: "Tokens" }, {
    id: "by-tool",
    label: "By tool",
    showInPhoneTitle: true
  }],
  listeners: ["serve"],
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
  listeners: ["serve"],
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
  listeners: ["serve"],
  requires: ["read"]
})

/** Local host observations only; no operational actions or peer aggregation. */
export const resourcesModule = defineModule({
  id: "resources",
  label: "Host resources",
  defaultPage: "overview",
  pages: [{ id: "overview", label: "Host resources" }],
  listeners: ["serve"],
  requires: ["read"]
})
