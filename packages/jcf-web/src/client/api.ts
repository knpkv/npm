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
import type { SessionAgentSettings } from "@knpkv/jira-clockify/agent/agentSettings.js"
import * as Data from "effect/Data"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import type {
  DescribeRowRequest,
  DescribeRowResponse,
  DescribeSavedEntryRequest,
  DescribeSavedEntryResponse,
  ManualPayload,
  OwnershipPayload,
  OwnershipResult,
  ReadProgress,
  StandingPayload,
  StandingResult,
  UpdateSavedEntryRequest,
  UpdateSavedEntryResponse,
  WeekPlanResponse,
  WeekScopeName,
  WriteResultResponse,
  WriteTargetsRequest
} from "../shared/contracts.js"

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

export class RequestFailure extends Data.TaggedError("RequestFailure")<{
  readonly message: string
  readonly status: number
  readonly maxSeconds?: number | undefined
}> {
  static is = Predicate.isTagged("RequestFailure")
}

const failureFrom = async (response: Response): Promise<RequestFailure> => {
  const text = await response.text()
  const { decodeErrorBody } = await import("./decoding.js")
  const parsed = decodeErrorBody(text)
  if (Option.isNone(parsed)) {
    return new RequestFailure({ message: text === "" ? response.statusText : text, status: response.status })
  }
  const body = parsed.value
  return new RequestFailure({ message: body.message ?? text, status: response.status, maxSeconds: body.maxSeconds })
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
  const { request } = await import("./transport.js")
  await request("/auth/bootstrap", {
    headers: { authorization: `Bearer ${token}` },
    method: "POST"
  }, async (response) => {
    // Cleared whether or not it worked: a code that failed is spent, and one that worked must not sit
    // in the address bar to be pasted into a chat window.
    window.history.replaceState(null, "", window.location.pathname)
    if (!response.ok) throw await failureFrom(response)
    const { decodeBootstrap } = await import("./decoding.js")
    const body = await decodeBootstrap(await response.json())
    writeCsrfToken(body.csrfToken)
  })
}

const post = async <A>(
  path: string,
  payload:
    | ConfirmRequest
    | typeof DescribeRowRequest.Type
    | DescribeSavedEntryRequest
    | UpdateSavedEntryRequest
    | typeof ManualPayload.Type
    | typeof OwnershipPayload.Type
    | typeof StandingPayload.Type
    | SessionAgentSettings,
  decode: (response: Response) => Promise<A>,
  signal?: AbortSignal
): Promise<A> => {
  const csrfToken = readCsrfToken()
  if (csrfToken === null) {
    throw new RequestFailure({ message: "This tab has no session — open the URL jcf-web printed", status: 401 })
  }
  const { request } = await import("./transport.js")
  return request(path, {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
    method: "POST",
    ...(signal !== undefined && { signal })
  }, async (response) => {
    if (!response.ok) throw await failureFrom(response)
    return decode(response)
  })
}

/** Edit the retained provider entry; the server verifies its current owner and snapshot. */
export const updateSavedEntry = async (payload: UpdateSavedEntryRequest): Promise<UpdateSavedEntryResponse> => {
  const { decodeSavedEntryUpdate } = await import("./decoding.js")
  const result = await post(
    "/api/entries/update",
    payload,
    async (response) => decodeSavedEntryUpdate(await response.json())
  )
  if (
    result.planId !== payload.planId || result.entry.source !== payload.source || result.entry.id !== payload.entryId
  ) {
    throw new RequestFailure({
      message: "The updated entry did not match this request. Refresh totals to check it.",
      status: 409
    })
  }
  return result
}

/** Generation is explicit and only reads retained evidence for the selected saved entry. */
export const describeSavedEntry = async (
  payload: DescribeSavedEntryRequest,
  signal?: AbortSignal
): Promise<DescribeSavedEntryResponse> => {
  const { decodeSavedEntryDescription } = await import("./decoding.js")
  const result = await post(
    "/api/entries/describe",
    payload,
    async (response) => decodeSavedEntryDescription(await response.json()),
    signal
  )
  if (result.planId !== payload.planId || result.source !== payload.source || result.entryId !== payload.entryId) {
    throw new RequestFailure({ message: "This description belongs to another entry. Generate it again.", status: 409 })
  }
  return result
}

/** Decode a bounded NDJSON read. A disconnected stream never counts as a completed week. */
export const readWeekStream = async (
  response: Response,
  onProgress: (progress: ReadProgress) => void
): Promise<WeekPlanResponse> => {
  if (!response.ok) throw await failureFrom(response)
  if (response.body === null) {
    throw new RequestFailure({ message: "The server returned no week stream. Retry the read.", status: 502 })
  }
  const { decodeWeekEvent } = await import("./decoding.js")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  try {
    while (true) {
      const chunk = await reader.read()
      pending += decoder.decode(chunk.value, { stream: !chunk.done })
      if (pending.length > 8_000_000) {
        throw new RequestFailure({ message: "The week response is too large.", status: 502 })
      }
      let newline = pending.indexOf("\n")
      while (newline !== -1) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (line.trim() !== "") {
          const event = await decodeWeekEvent(line)
          if (event._tag === "Complete") return event.plan
          if (event._tag === "Failed") throw new RequestFailure({ message: event.message, status: 500 })
          onProgress(event.progress)
        }
        newline = pending.indexOf("\n")
      }
      if (chunk.done) {
        throw new RequestFailure({
          message: "The connection ended before the week was ready. Retry the read.",
          status: 502
        })
      }
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

/** Read only the cached view; absent evidence is explicit and never launches an agent. */
export const readSavedWeek = async (monday: string | undefined, scope: WeekScopeName, signal: AbortSignal) => {
  const query = new URLSearchParams({ only: scope })
  if (monday !== undefined) query.set("monday", monday)
  const { request } = await import("./transport.js")
  return request(`/api/week/saved?${query}`, { method: "GET", signal }, async (response) => {
    if (!response.ok) throw await failureFrom(response)
    return (await import("./decoding.js")).decodeSavedWeek(await response.json())
  })
}

export const readWeek = async (
  monday: string | undefined,
  scope: WeekScopeName,
  signal: AbortSignal,
  onProgress: (progress: ReadProgress) => void
): Promise<WeekPlanResponse> => {
  const query = new URLSearchParams()
  if (monday !== undefined) query.set("monday", monday)
  if (scope !== "both") query.set("only", scope)
  const { request } = await import("./transport.js")
  return request(
    `/api/week/stream?${query}`,
    { method: "GET", signal },
    (response) => readWeekStream(response, onProgress)
  )
}

/** Load saved provider time for a week without reading session evidence. */
export const readRecordedWeek = async (
  monday: string | undefined,
  scope: WeekScopeName,
  signal: AbortSignal,
  onProgress: (progress: ReadProgress) => void
): Promise<WeekPlanResponse> => {
  const query = new URLSearchParams({ only: scope })
  if (monday !== undefined) query.set("monday", monday)
  const { request } = await import("./transport.js")
  return request(
    `/api/week/recorded-only?${query}`,
    { method: "GET", signal },
    (response) => readWeekStream(response, onProgress)
  )
}

/** Reread only provider facts for the server-held session plan. */
export const refreshRecordedTime = async (
  planId: string,
  signal: AbortSignal,
  onProgress: (progress: ReadProgress) => void
): Promise<WeekPlanResponse> => {
  const { request } = await import("./transport.js")
  const query = new URLSearchParams({ planId })
  return request(
    `/api/week/recorded?${query}`,
    { method: "GET", signal },
    (response) => readWeekStream(response, onProgress)
  )
}

export interface ConfirmRequest {
  readonly planId: string
  readonly rowId: string
  /** Which of the row's blocks to write, by position. Omitted means all of them. */
  readonly blocks?: ReadonlyArray<number> | undefined
  readonly seconds?: number | undefined
  readonly ticketKey?: string | undefined
  readonly note?: string | undefined
  readonly targets?: WriteTargetsRequest
}

export const confirmRow = (request: ConfirmRequest): Promise<WriteResultResponse> =>
  post(
    "/api/rows/confirm",
    request,
    async (response) => (await import("./decoding.js")).decodeWriteResult(await response.json())
  )

/** Suggest a note from retained row evidence when its editor opens. Never reads sessions again. */
export const describeRow = (
  request: typeof DescribeRowRequest.Type,
  signal: AbortSignal
): Promise<typeof DescribeRowResponse.Type> =>
  post(
    "/api/rows/describe",
    request,
    async (response) => (await import("./decoding.js")).decodeDescription(await response.json()),
    signal
  )

export const logManual = (request: typeof ManualPayload.Type): Promise<WriteResultResponse> =>
  post(
    "/api/rows/manual",
    request,
    async (response) => (await import("./decoding.js")).decodeWriteResult(await response.json())
  )

/** Claim a ticket as yours for good, so its hours stop being withheld every week. */
export const markTicketMine = (
  request: { readonly ticketKey: string }
): Promise<typeof OwnershipResult.Type> =>
  post(
    "/api/config/mine",
    request,
    async (response) => (await import("./decoding.js")).decodeOwnershipResult(await response.json())
  )

export const mapStandingAttribution = (
  request: { readonly cwd: string; readonly ticketKey: string }
): Promise<typeof StandingResult.Type> =>
  post(
    "/api/config/standing",
    request,
    async (response) => (await import("./decoding.js")).decodeStandingResult(await response.json())
  )

/** Agent configuration is owner-only; reading or saving it never scans sessions. */
export const readAgentSettings = async (signal: AbortSignal): Promise<SessionAgentSettings> => {
  const { request } = await import("./transport.js")
  return request("/api/config/agent", { method: "GET", signal }, async (response) => {
    if (!response.ok) throw await failureFrom(response)
    return (await import("./decoding.js")).decodeAgentSettings(await response.json())
  })
}

export const saveAgentSettings = (settings: SessionAgentSettings): Promise<SessionAgentSettings> =>
  post(
    "/api/config/agent",
    settings,
    async (response) => (await import("./decoding.js")).decodeAgentSettings(await response.json())
  )
