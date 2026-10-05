import type { OwnerSessionService } from "@knpkv/browser-pairing/owner-session"
import { Redacted } from "effect"

/** The CSRF header value a page receives from the bootstrap exchange. */
export const csrfOf = (session: OwnerSessionService): string =>
  session.writes._tag === "Csrf" ? Redacted.value(session.writes.token) : ""
