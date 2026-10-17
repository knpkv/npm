/**
 * Names a commit the way a person reads one: its title and when it was committed. The id stays out
 * of the text; it is in the tooltip and behind a copy button, since a tooltip alone fails on touch
 * and keyboard.
 *
 *   <CommitSummaryProvider source={useCommitSummaries(load, now, timeZone)}>
 *     Reviewed 14:02, head <CommitLabel commit={headCommit} />
 *   </CommitSummaryProvider>
 *
 * @module
 */
import { IconButton } from "@knpkv/rly/primitives"
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react"

/** What is known about one commit's title and time. */
export type CommitSummaryReading =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly title: string | null; readonly committedAt: number }
  | { readonly _tag: "Unavailable" }

/** A loaded commit: `title` is null when its message has no text. */
export interface CommitSummary {
  readonly title: string | null
  readonly committedAt: number
}

/**
 * Where labels read commits from; `request` starts a load the first time a label asks. `now` is the
 * time the page's reading was taken, which decides "today"; null gives every label its date.
 */
export interface CommitSummarySource {
  readonly read: (commitId: string) => CommitSummaryReading
  readonly request?: (commitId: string) => void
  readonly now: number | null
  readonly timeZone?: string | undefined
}

const unavailable: CommitSummaryReading = { _tag: "Unavailable" }
const CommitSummaryContext = createContext<CommitSummarySource>({ read: () => unavailable, now: null })

/** Gives every CommitLabel below it the same source. */
export const CommitSummaryProvider = ({
  children,
  source
}: {
  readonly children: ReactNode
  readonly source: CommitSummarySource
}): ReactElement => <CommitSummaryContext.Provider value={source}>{children}</CommitSummaryContext.Provider>

const dayKey = (timestamp: number, timeZone?: string): string =>
  new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(timestamp)

/** "14:18" for a commit made the day of `now` in the reader's zone, "15 Oct 14:18" otherwise. Never relative. */
export const commitTimeWords = (committedAt: number, now: number | null, timeZone?: string): string => {
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone
  }).format(committedAt)
  if (now !== null && dayKey(committedAt, timeZone) === dayKey(now, timeZone)) return time
  const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone }).format(committedAt)
  return `${day} ${time}`
}

/** The part that may truncate, and the part that must stay: `["Title", ", 14:18"]`. */
const labelWords = (
  reading: CommitSummaryReading,
  now: number | null,
  timeZone?: string
): readonly [string, string] => {
  switch (reading._tag) {
    case "Loading":
      return ["Reading commit…", ""]
    case "Unavailable":
      return ["Commit title unavailable", ""]
    case "Ready":
      return [reading.title ?? "Commit title unavailable", `, ${commitTimeWords(reading.committedAt, now, timeZone)}`]
  }
}

/**
 * One commit, as “Title, 14:18”. `copy={false}` leaves the copy button out where it cannot keep a
 * 44px target, such as inside the shrunk canvas drawing; the tooltip still carries the id there.
 */
export const CommitLabel = ({
  className,
  commit,
  copy = true
}: {
  readonly className?: string
  readonly commit: string
  readonly copy?: boolean
}): ReactElement => {
  const source = useContext(CommitSummaryContext)
  const { request } = source
  useEffect(() => request?.(commit), [request, commit])
  const reading = source.read(commit)
  const [title, time] = labelWords(reading, source.now, source.timeZone)
  return (
    <span className={["rv-commit", className].filter(Boolean).join(" ")} data-commit-label="">
      <span
        aria-busy={reading._tag === "Loading" ? "true" : undefined}
        className="rv-commit-words"
        title={
          reading._tag === "Ready" && reading.title !== null ? `${reading.title}\nCommit ${commit}` : `Commit ${commit}`
        }
      >
        “<span className="rv-commit-title">{title}</span>
        {time}”
      </span>
      {copy ? (
        <IconButton
          className="rv-commit-copy"
          icon="copy"
          label="Copy commit id"
          onClick={() => void navigator.clipboard?.writeText(commit)}
          size="compact"
          title="Copy commit id"
          variant="quiet"
        />
      ) : null}
    </span>
  )
}

/** The label's words without quotes or button, for places that take only text, like a fact row. */
export function useCommitWords(commit: string): string
export function useCommitWords(commit: string | null): string | null
/**
 * Null reads nothing and gives null, so a component can call it for an optional commit, such as a
 * finding that may or may not have a pushed fix.
 */
export function useCommitWords(commit: string | null): string | null {
  const source = useContext(CommitSummaryContext)
  const { request } = source
  useEffect(() => {
    if (commit !== null) request?.(commit)
  }, [request, commit])
  if (commit === null) return null
  const [title, time] = labelWords(source.read(commit), source.now, source.timeZone)
  return `${title}${time}`
}

interface CommitSummaryStore {
  readonly load: (commitId: string) => Promise<CommitSummary>
  readonly readings: ReadonlyMap<string, CommitSummaryReading>
}

const noReadings: ReadonlyMap<string, CommitSummaryReading> = new Map()

/**
 * Loads each commit at most once through `load` and holds the result. A rejected load reads as
 * Unavailable, so the label says the title is missing instead of showing an id.
 */
export const useCommitSummaries = (
  load: (commitId: string) => Promise<CommitSummary>,
  now: number | null,
  timeZone?: string
): CommitSummarySource => {
  // Readings belong to one loader: a new loader (another pull request) starts afresh without remounting.
  const [store, setStore] = useState<CommitSummaryStore>(() => ({ load, readings: new Map() }))
  const requested = useRef<{ readonly load: typeof load; readonly ids: Set<string> }>({ load, ids: new Set() })
  if (requested.current.load !== load) requested.current = { load, ids: new Set() }
  const readings = store.load === load ? store.readings : noReadings
  const request = useCallback(
    (commitId: string) => {
      if (requested.current.ids.has(commitId)) return
      requested.current.ids.add(commitId)
      const settle = (reading: CommitSummaryReading) =>
        setStore((current) => ({
          load,
          readings: new Map(current.load === load ? current.readings : noReadings).set(commitId, reading)
        }))
      load(commitId).then(
        (summary) => settle({ _tag: "Ready", ...summary }),
        () => settle(unavailable)
      )
    },
    [load]
  )
  return useMemo(
    (): CommitSummarySource => ({
      read: (commitId: string) => readings.get(commitId) ?? { _tag: "Loading" },
      request,
      now,
      timeZone
    }),
    [readings, request, now, timeZone]
  )
}
