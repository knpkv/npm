/**
 * What an app says about itself, what nix tells the hub, and what the hub concludes per app.
 *
 * **Mental model**
 *
 * - `apps.json` (written by nix) holds only ids and sockets. Everything else comes from the app's own
 *   `GET /app/manifest`, so the file can't disagree with the code.
 * - `contract` is one integer for the whole shell ↔ app surface: manifest shape, wire paths, shell
 *   services and `ShellContext`. Additive changes keep it; the hub supports the current and previous one.
 * - Every per-app problem becomes an {@link AppState} `Unavailable`, never a hub failure.
 *
 * @module
 */
import { Schema } from "effect"
import { ModuleDescriptor } from "./module.js"

/** Contracts this package's runner and types speak. The hub declares its own supported list. */
export const AppContract = Schema.Literals([1])
export type AppContract = typeof AppContract.Type

export const AppId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/), Schema.isMaxLength(64)).pipe(
  Schema.brand("AppId")
)
export type AppId = typeof AppId.Type

/** Hub services an app may call; an undeclared one fails with `ShellServiceUnavailable("undeclared")`. */
export const ShellService = Schema.Literals(["fleet.read", "host", "jobs.submit", "relay.post", "needs-you", "badge"])
export type ShellService = typeof ShellService.Type

const AssetPath = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/))

/** The client the runner serves under `/app/assets/`: one ES module entry and its stylesheets. */
export const AppClientAssets = Schema.Struct({
  entry: AssetPath,
  css: Schema.Array(AssetPath)
})
export type AppClientAssets = typeof AppClientAssets.Type

/** Served at `GET /app/manifest`. `module.id` is the app id; the version is display-only. */
export const AppManifest = Schema.Struct({
  contract: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  id: AppId,
  package: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(214)),
  version: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  module: ModuleDescriptor,
  client: AppClientAssets,
  services: Schema.Array(ShellService),
  nav: Schema.Struct({
    order: Schema.Int,
    primary: Schema.Boolean,
    mobile: Schema.Boolean
  }),
  standalone: Schema.Struct({ defaultPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })) })
})
export interface AppManifest extends Schema.Schema.Type<typeof AppManifest> {}

/** What an app declares in code; the runner adds `client` from its build output. */
export type AppManifestInput = Omit<AppManifest, "client">

const SocketPath = Schema.String.check(Schema.isPattern(/^\//), Schema.isMaxLength(107))

/** `apps.json` v1: nix starts each app and names its socket. Replaced by {@link AppsConfigV2}. */
export const AppsConfigV1 = Schema.Struct({
  v: Schema.Literal(1),
  apps: Schema.Array(Schema.Struct({ id: AppId, socket: SocketPath }))
})
export interface AppsConfigV1 extends Schema.Schema.Type<typeof AppsConfigV1> {}

/**
 * One installed app in `apps.json` v2: the prefix holding its `node_modules`, the script the hub runs with its
 * own node, and how it runs.
 */
export const InstalledApp = Schema.Struct({
  id: AppId,
  package: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(214)),
  /** Exact, resolved. */
  version: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  /** The prefix holding `node_modules`. */
  dir: Schema.String.check(Schema.isNonEmpty()),
  /** The app's script, relative to `dir`, from its package's `hubApp.bin`. */
  bin: Schema.String.check(Schema.isNonEmpty()),
  enabled: Schema.Boolean,
  /** V8 heap cap (`--max-old-space-size`); native and RSS growth are not capped. */
  memoryMb: Schema.Int.check(Schema.isBetween({ minimum: 64, maximum: 16_384 })),
  allowScripts: Schema.Boolean
})
export interface InstalledApp extends Schema.Schema.Type<typeof InstalledApp> {}

/**
 * `apps.json` v2: the hub starts and supervises each app itself. One writer, named in the file: the `herdr-hub
 * apps` CLI (`cli`) or nix (`nix`, which the CLI then refuses to edit). `trust.scopes` holds npm scopes
 * (`@knpkv`) or exact package names the CLI installs from without `apps trust add`.
 */
export const AppsConfigV2 = Schema.Struct({
  v: Schema.Literal(2),
  managedBy: Schema.Literals(["cli", "nix"]),
  trust: Schema.Struct({ scopes: Schema.Array(Schema.String) }),
  apps: Schema.Array(InstalledApp)
})
export interface AppsConfigV2 extends Schema.Schema.Type<typeof AppsConfigV2> {}

/** `~/.config/herdr/apps.json`, as the hub reads it. Unknown keys are refused. */
export const AppsConfig = Schema.Union([AppsConfigV1, AppsConfigV2])
export type AppsConfig = typeof AppsConfig.Type

/**
 * Line 1 of an attached app's stdin, written by the hub at spawn; the pipe then stays open until stop. The
 * endpoint is a socket path or a `\\.\pipe\` name picked per spawn. The token and secret are fresh per spawn
 * and never touch disk, env or argv.
 */
export const HubHandshake = Schema.Struct({
  v: Schema.Literal(1),
  endpoint: Schema.String.check(Schema.isNonEmpty()),
  hubUrl: Schema.String.check(Schema.isNonEmpty()),
  hubToken: Schema.RedactedFromValue(Schema.String),
  appSecret: Schema.RedactedFromValue(Schema.String)
})
export interface HubHandshake extends Schema.Schema.Type<typeof HubHandshake> {}

/** The `hubApp` field of an app's package.json: what the installer checks before and after install. */
export const HubAppPackageField = Schema.Struct({
  bin: Schema.String.check(Schema.isNonEmpty()),
  contract: AppContract,
  services: Schema.Array(ShellService)
})
export interface HubAppPackageField extends Schema.Schema.Type<typeof HubAppPackageField> {}

export const AppUnavailableReason = Schema.Literals([
  "starting",
  "not_running",
  "crashloop",
  "disabled",
  "install_missing",
  "health",
  "timeout",
  "invalid_manifest",
  "id_mismatch",
  "incompatible",
  "duplicate",
  "client_failed"
])
export type AppUnavailableReason = typeof AppUnavailableReason.Type

/**
 * The hub's view of one registered app, served by `GET /v1/apps`. `Unavailable` keeps the last good
 * manifest, when there is one, so the shell still shows the app's real label and pages.
 */
export const AppState = Schema.Union([
  Schema.TaggedStruct("Ready", { manifest: AppManifest }),
  Schema.TaggedStruct("Unavailable", {
    id: AppId,
    manifest: Schema.NullOr(AppManifest),
    reason: AppUnavailableReason,
    detail: Schema.String
  })
])
export type AppState = typeof AppState.Type

export const AppStates = Schema.Struct({ contract: AppContract, apps: Schema.Array(AppState) })
export interface AppStates extends Schema.Schema.Type<typeof AppStates> {}

/** `apps.json` exists but doesn't decode; the hub keeps its previous app list. */
export class AppsConfigInvalid extends Schema.TaggedError<AppsConfigInvalid>()("AppsConfigInvalid", {
  path: Schema.String
}) {}

/** One probe's outcome other than `Ready`. */
export class AppProbeFailed extends Schema.TaggedError<AppProbeFailed>()("AppProbeFailed", {
  id: AppId,
  reason: AppUnavailableReason,
  detail: Schema.String
}) {}

/** A proxied request reached an app that isn't answering. The proxy answers 503 `app_unavailable`. */
export class AppUnavailable extends Schema.TaggedError<AppUnavailable>()("AppUnavailable", { id: AppId }) {}

/**
 * A grant the hub doesn't recognise, has expired, was already spent, belongs to another app, or was minted for a
 * read (`read_only`: a GET skips the same-origin check, so its grant may not submit a job).
 */
export class GrantInvalid extends Schema.TaggedError<GrantInvalid>()("GrantInvalid", {
  reason: Schema.Literals(["unknown", "expired", "used", "app_mismatch", "read_only"])
}) {}

/** A shell service the app can't use here: running standalone, not declared, or the hub is down. */
export class ShellServiceUnavailable extends Schema.TaggedError<ShellServiceUnavailable>()(
  "ShellServiceUnavailable",
  {
    service: ShellService,
    reason: Schema.Literals(["standalone", "undeclared", "hub_down"])
  }
) {}

/** The app couldn't start: its manifest, its listener, or its handler layer. */
export class AppStartError extends Schema.TaggedError<AppStartError>()("AppStartError", {
  reason: Schema.Literals(["invalid_manifest", "invalid_arguments", "listen", "layer", "handshake"]),
  cause: Schema.Defect()
}) {}
