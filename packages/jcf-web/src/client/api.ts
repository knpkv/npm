/**
 * Talking to the server from the page.
 *
 * **Mental model**
 *
 * - **The URL is the handshake.** The bootstrap code arrives in the fragment, is exchanged once for
 *   the session cookie, and is wiped from the address bar. Reloading the page afterwards works
 *   because the cookie is what authenticates, not the URL.
 * - **Every mutation carries the CSRF token**, which lives in this tab's storage and nowhere a
 *   cross-origin page can read it.
 * - **Nothing here computes hours.** The server owns every number; this module moves JSON.
 *
 * @module
 */
import type { Schema } from "effect"
import type { ManualPayload, StandingResult, WeekPlanResponse, WriteResultResponse } from "../server/Api.js"

const csrfStorageKey = "jcf_web_csrf"

/** Falls back to memory: a private window with storage blocked should still be usable. */
let inMemoryCsrfToken: string | null = null

const readCsrfToken = (): string | null => {
  try {
    return window.localStorage.getItem(csrfStorageKey) ?? inMemoryCsrfToken
  } catch {
    return inMemoryCsrfToken
  }
}

const writeCsrfToken = (token: string): void => {
  inMemoryCsrfToken = token
  try {
    window.localStorage.setItem(csrfStorageKey, token)
  } catch {
    // Storage is unavailable; the in-memory copy carries this tab.
  }
}

export class RequestFailure extends Error {
  readonly status: number
  readonly maxSeconds: number | undefined
  constructor(options: { readonly message: string; readonly status: number; readonly maxSeconds?: number }) {
    super(options.message)
    this.name = "RequestFailure"
    this.status = options.status
    this.maxSeconds = options.maxSeconds
  }
}

interface ErrorBody {
  readonly message?: unknown
  readonly maxSeconds?: unknown
}

const failureFrom = async (response: Response): Promise<RequestFailure> => {
  const text = await response.text()
  try {
    const body: ErrorBody = JSON.parse(text)
    return new RequestFailure({
      message: typeof body.message === "string" ? body.message : text,
      status: response.status,
      ...(typeof body.maxSeconds === "number" ? { maxSeconds: body.maxSeconds } : {})
    })
  } catch {
    return new RequestFailure({ message: text === "" ? response.statusText : text, status: response.status })
  }
}

/**
 * Spend the bootstrap code, if this load carries one.
 *
 * Idempotent from the page's point of view: a reload has no fragment and simply relies on the
 * cookie. The code is one-time on the server, so a second exchange of the same code is refused
 * there rather than guarded here.
 */
export const bootstrapSession = async (): Promise<void> => {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("bootstrap_token")
  if (token === null) return
  const response = await fetch("/auth/bootstrap", {
    credentials: "same-origin",
    headers: { authorization: `Bearer ${token}` },
    method: "POST"
  })
  // Cleared whether or not it worked: a code that failed is spent, and one that worked must not sit
  // in the address bar to be pasted into a chat window.
  window.history.replaceState(null, "", window.location.pathname)
  if (!response.ok) throw await failureFrom(response)
  const body: { readonly csrfToken?: unknown } = await response.json()
  if (typeof body.csrfToken !== "string") {
    throw new RequestFailure({ message: "The server returned no CSRF token", status: response.status })
  }
  writeCsrfToken(body.csrfToken)
}

const get = async <A>(path: string): Promise<A> => {
  const response = await fetch(path, { credentials: "same-origin" })
  if (!response.ok) throw await failureFrom(response)
  return response.json() as Promise<A>
}

const post = async <A>(path: string, payload: unknown): Promise<A> => {
  const csrfToken = readCsrfToken()
  if (csrfToken === null) {
    throw new RequestFailure({ message: "This tab has no session — open the URL jcf-web printed", status: 401 })
  }
  const response = await fetch(path, {
    body: JSON.stringify(payload),
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    method: "POST"
  })
  if (!response.ok) throw await failureFrom(response)
  return response.json() as Promise<A>
}

export const readWeek = (monday: string | undefined): Promise<WeekPlanResponse> =>
  get(monday === undefined ? "/api/week" : `/api/week?monday=${encodeURIComponent(monday)}`)

export interface ConfirmRequest {
  readonly planId: string
  readonly rowId: string
  readonly seconds?: number
  readonly ticketKey?: string
  readonly note?: string
}

export const confirmRow = (request: ConfirmRequest): Promise<WriteResultResponse> => post("/api/rows/confirm", request)

export const logManual = (request: Schema.Schema.Type<typeof ManualPayload>): Promise<WriteResultResponse> =>
  post("/api/rows/manual", request)

export const mapStandingAttribution = (
  request: { readonly cwd: string; readonly ticketKey: string }
): Promise<Schema.Schema.Type<typeof StandingResult>> => post("/api/config/standing", request)
