/**
 * The words the hub shows for an app it can't show, shared by the registry (on the server) and the shell (in the
 * browser, for a client that fails to load). No platform imports, so the browser bundle can take it.
 *
 * @module
 */
import type { AppUnavailableReason } from "@knpkv/hub-app"

/** Public copy for each reason; never a path or a provider error. */
export const unavailableDetail = (label: string, reason: AppUnavailableReason): string => {
  switch (reason) {
    case "starting":
      return `${label} is starting.`
    case "not_running":
      return `${label} isn't running.`
    case "crashloop":
      return `${label} kept stopping, so it was left off. Restart it once it's fixed.`
    case "disabled":
      return `${label} is turned off.`
    case "install_missing":
      return `${label}'s files are missing. Update it to install them again.`
    case "health":
      return `${label} stopped answering and is being restarted.`
    case "timeout":
      return `${label} didn't answer in time.`
    case "invalid_manifest":
      return `${label} described itself in a way this hub can't read.`
    case "id_mismatch":
      return `${label} answered as a different app.`
    case "incompatible":
      return `${label} needs a different version of the hub.`
    case "duplicate":
      return `${label} uses a name another module already has.`
    case "client_failed":
      return `${label} couldn't be shown.`
    case "local_only":
      return `${label} opens only on this machine for now.`
  }
}
