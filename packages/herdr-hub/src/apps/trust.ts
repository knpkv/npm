/**
 * What the CLI tells the user before it installs an app, and which packages it installs at all.
 *
 * Mental model:
 * - **Allowlist.** `apps.json`'s `trust.scopes` holds scopes (`@knpkv`) and exact package names. Inside it the CLI
 *   asks y/N (`--yes` skips the question); outside it `add` refuses with `AppNotTrusted` until `apps trust add` (which
 *   needs a terminal) widens it.
 * - **No false promises.** The prompt says plainly that an app runs as the user with access to the user's files;
 *   `services` narrow what the hub lets it do, not what the OS lets it do.
 *
 * @since 0.1.0
 */
import type { ShellService } from "@knpkv/hub-app"
import { Schema } from "effect"
import type { ResolvedApp } from "./npm.js"

/** The package is outside `trust.scopes`. */
export class AppNotTrusted extends Schema.TaggedError<AppNotTrusted>()("AppNotTrusted", { package: Schema.String }) {}

/** Whether `pkg` is inside `scopes`: a `@scope` entry covers its packages, any other entry is one exact name. */
export const isTrusted = (scopes: ReadonlyArray<string>, pkg: string): boolean =>
  scopes.some((scope) => scope.startsWith("@") && !scope.includes("/") ? pkg.startsWith(`${scope}/`) : pkg === scope)

const serviceWords = {
  "fleet.read": "reads the state of every fleet host",
  host: "reads this machine's host details",
  "jobs.submit": "can submit jobs as you after you click",
  "relay.post": "can post to Relay as you",
  "needs-you": "can add items to your needs-you list",
  badge: "can show a badge in the navigation"
} satisfies Record<ShellService, string>

/** Whether signatures could be checked on the registry the package came from. */
export type SignatureCheck = "verified" | "registry_has_no_signatures"

/** The lines shown before installing `app`, in order. */
export const trustLines = (app: ResolvedApp, signatures: SignatureCheck | null): ReadonlyArray<string> => [
  `${app.package}@${app.version}${app.publishedAt === null ? "" : `, published ${app.publishedAt}`}`,
  `Maintainers: ${app.maintainers.length === 0 ? "none listed" : app.maintainers.join(", ")}`,
  app.provenance ? "Provenance: the registry has a build attestation" : "Provenance: none",
  app.installScripts.length === 0
    ? "Install scripts: none declared"
    : `Install scripts: ${app.installScripts.join(", ")} (not run unless you pass --allow-scripts)`,
  ...(signatures === null
    ? []
    : [signatures === "verified" ? "Registry signatures: verified" : "Registry signatures: this registry has none"]),
  app.hubApp.services.length === 0
    ? "Hub access: none"
    : `Hub access: ${app.hubApp.services.map((service) => serviceWords[service]).join("; ")}`,
  "This app runs as you, with access to your files."
]
