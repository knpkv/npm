import { CheckIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"

interface RollingStatusProps {
  readonly statusDetail: string | undefined
  readonly isLoading: boolean
}

// --- Phase parsing ---

interface ParsedMessage {
  readonly phase: string
  readonly label: string
  readonly detail: string
  readonly current?: number
  readonly total?: number
}

const PROGRESS_RE = /^fetching (comments|diffs) \((\d+)\/(\d+)\)$/
const FETCH_PR_RE = /^(.+?) #(\S+) (.+)$/
const SYNC_RE = /^syncing (W\d+)/

function parseMessage(msg: string): ParsedMessage {
  if (msg === "loading from cache...") {
    return { phase: "cache", label: "Cache", detail: "loading from cache" }
  }

  const progress = msg.match(PROGRESS_RE)
  if (progress) {
    const kind = progress[1] === "comments" ? "comments" : "diffs"
    return {
      phase: kind,
      label: kind === "comments" ? "Comments" : "Diffs",
      detail: msg,
      current: Number(progress[2]),
      total: Number(progress[3])
    }
  }

  if (msg === "calculating health scores") {
    return { phase: "health", label: "Health", detail: "calculating scores" }
  }

  if (SYNC_RE.test(msg)) {
    return { phase: "sync", label: "Sync", detail: msg }
  }

  // Per-PR fetch: "profile (region) #123 repoName"
  const prMatch = msg.match(FETCH_PR_RE)
  if (prMatch) {
    return { phase: "fetch", label: "Fetching", detail: msg }
  }

  // Account list: "profile1 (region1), profile2 (region2)"
  if (msg.includes("(") && msg.includes(")")) {
    return { phase: "fetch", label: "Fetching", detail: msg }
  }

  return { phase: "unknown", label: "Working", detail: msg }
}

// --- Phase state ---

interface PhaseState {
  readonly id: string
  readonly label: string
  readonly items: Array<{ id: number; text: string }>
  readonly current: number | null
  readonly total: number | null
  readonly complete: boolean
  readonly itemCount: number
}

const MAX_PHASE_ITEMS = 3

export function RollingStatus({ isLoading, statusDetail }: RollingStatusProps) {
  const seqRef = useRef(0)
  const [phases, setPhases] = useState<Array<PhaseState>>([])

  useEffect(() => {
    if (!isLoading || !statusDetail) return

    const parsed = parseMessage(statusDetail)

    setPhases((prev) => {
      const existing = prev.findIndex((p) => p.id === parsed.phase)
      const itemId = ++seqRef.current

      if (existing >= 0) {
        // Same phase — update it
        return prev.map((p, i) => {
          if (i !== existing) return p
          const items = [...p.items, { id: itemId, text: parsed.detail }]
          if (items.length > MAX_PHASE_ITEMS) items.splice(0, items.length - MAX_PHASE_ITEMS)
          return {
            ...p,
            items,
            current: parsed.current ?? p.current,
            total: parsed.total ?? p.total,
            itemCount: p.itemCount + 1
          }
        })
      }

      // New phase — mark all previous as complete
      const completed: Array<PhaseState> = prev.map((p) => ({ ...p, complete: true, items: [] }))
      const newPhase: PhaseState = {
        id: parsed.phase,
        label: parsed.label,
        items: [{ id: itemId, text: parsed.detail }],
        current: parsed.current ?? null,
        total: parsed.total ?? null,
        complete: false,
        itemCount: 1
      }
      return [...completed, newPhase]
    })
  }, [statusDetail, isLoading])

  useEffect(() => {
    if (!isLoading) {
      seqRef.current = 0
      setPhases([])
    }
  }, [isLoading])

  if (phases.length === 0) return null

  return (
    <div className="flex flex-1 flex-col justify-end gap-0.5 overflow-hidden" style={{ maxHeight: "4.5rem" }}>
      {phases.map((phase) => (
        <PhaseRow key={phase.id} phase={phase} />
      ))}
    </div>
  )
}

function PhaseRow({ phase }: { phase: PhaseState }) {
  if (phase.complete) {
    // Collapsed completed phase
    return (
      <div className="rolling-line flex items-center gap-2 text-xs text-muted-foreground">
        <CheckIcon className="size-3 text-green-500 shrink-0" />
        <span className="font-medium">{phase.label}</span>
        <span className="opacity-50">
          {phase.total != null ? `${phase.total}/${phase.total}` : `${phase.itemCount} items`}
        </span>
      </div>
    )
  }

  // Active phase — expanded with detail lines
  return (
    <div className="flex flex-col">
      <div className="rolling-line flex items-center gap-2 text-xs">
        <span className="size-3 shrink-0 flex items-center justify-center">
          <span className="size-1.5 animate-pulse rounded-full bg-blue-500" />
        </span>
        <span className="font-medium text-foreground">{phase.label}</span>
        {phase.total != null && (
          <span className="font-mono text-muted-foreground tabular-nums">
            {phase.current ?? 0}/{phase.total}
          </span>
        )}
      </div>
      <div
        className="ml-5 flex flex-col overflow-hidden"
        style={{
          maskImage: "linear-gradient(to bottom, transparent 0%, black 40%)",
          WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 40%)"
        }}
      >
        {phase.items.map((item, i) => {
          const fromEnd = phase.items.length - 1 - i
          const opacity = fromEnd === 0 ? 0.7 : fromEnd === 1 ? 0.35 : 0.15
          return (
            <span
              key={item.id}
              className="rolling-line truncate font-mono text-[11px] leading-relaxed text-muted-foreground"
              style={
                {
                  "--rolling-opacity": opacity,
                  opacity
                } as React.CSSProperties
              }
            >
              {item.text}
            </span>
          )
        })}
      </div>
    </div>
  )
}
