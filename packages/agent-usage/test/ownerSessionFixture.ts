import type { OwnerSessionService } from "@knpkv/browser-pairing/owner-session"

/** The `name=value` pair a browser sends back for the session cookie. */
export const cookieOf = (session: OwnerSessionService): string => session.sessionCookie.split(";")[0] ?? ""

/** The raw session token, as the page's cookie carries it. */
export const ownerTokenOf = (session: OwnerSessionService): string =>
  decodeURIComponent(cookieOf(session).slice(`${session.cookieName}=`.length))
