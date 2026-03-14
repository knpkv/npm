/**
 * @title Audit log page — browse and export AWS API call history
 *
 * Uses mutation atoms with `mode: "promise"` for dynamic filter/pagination.
 *
 * @module
 */
import { useAtom } from "@effect-atom/atom-react"
import { ArrowLeftIcon, DownloadIcon, SearchIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router"
import { auditExportAtom, auditLogQueryAtom } from "../atoms/app.js"
import { Badge } from "./ui/badge.js"
import { Button } from "./ui/button.js"
import { Input } from "./ui/input.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.js"

const PAGE_SIZE = 50

interface AuditEntry {
  readonly id: number
  readonly timestamp: string
  readonly operation: string
  readonly accountProfile: string
  readonly region: string
  readonly permissionState: string
  readonly context: string
  readonly durationMs: number | null
}

const stateBadgeVariant = (state: string) => {
  switch (state) {
    case "always_allowed":
      return "secondary" as const
    case "allowed":
      return "default" as const
    case "denied":
      return "destructive" as const
    case "timed_out":
      return "outline" as const
    default:
      return "outline" as const
  }
}

export function AuditLogPage() {
  const navigate = useNavigate()
  const [, fetchLog] = useAtom(auditLogQueryAtom, { mode: "promise" })
  const [, fetchExport] = useAtom(auditExportAtom, { mode: "promise" })

  const [entries, setEntries] = useState<ReadonlyArray<AuditEntry>>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [offset, setOffset] = useState(0)
  const [search, setSearch] = useState("")
  const [operationFilter, setOperationFilter] = useState<string>("")
  const [stateFilter, setStateFilter] = useState<string>("")

  const urlParams = useMemo(() => {
    const p: Record<string, string | number> = { limit: PAGE_SIZE, offset }
    if (search) p.search = search
    if (operationFilter) p.operation = operationFilter
    if (stateFilter) p.permissionState = stateFilter
    return p
  }, [offset, search, operationFilter, stateFilter])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchLog({ urlParams })
      .then((result) => {
        if (cancelled) return
        setEntries(result.items as ReadonlyArray<AuditEntry>)
        setTotal(result.total)
        setLoading(false)
      })
      .catch(() => setLoading(false))
    return () => {
      cancelled = true
    }
  }, [fetchLog, urlParams])

  const hasMore = offset + PAGE_SIZE < total

  const exportJson = useCallback(() => {
    fetchExport({ urlParams: {} })
      .then((result) => {
        const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" })
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.json`
        a.click()
        URL.revokeObjectURL(url)
      })
      .catch(() => {})
  }, [fetchExport])

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" className="gap-2" onClick={() => navigate("/")}>
          <ArrowLeftIcon className="size-4" />
          Back
        </Button>
        <h1 className="text-lg font-semibold">Audit Log</h1>
        <span className="text-sm text-muted-foreground">{total} entries</span>
        <div className="ml-auto">
          <Button variant="outline" size="sm" className="gap-2" onClick={exportJson}>
            <DownloadIcon className="size-3" />
            Export JSON
          </Button>
        </div>
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <SearchIcon className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            placeholder="Search operations and context..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setOffset(0)
            }}
            className="pl-9"
          />
        </div>
        <Select
          value={operationFilter || "all"}
          onValueChange={(v) => {
            setOperationFilter(v === "all" ? "" : v)
            setOffset(0)
          }}
        >
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Operation" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All operations</SelectItem>
            <SelectItem value="getPullRequests">getPullRequests</SelectItem>
            <SelectItem value="getCallerIdentity">getCallerIdentity</SelectItem>
            <SelectItem value="createPullRequest">createPullRequest</SelectItem>
            <SelectItem value="listRepositories">listRepositories</SelectItem>
            <SelectItem value="listBranches">listBranches</SelectItem>
            <SelectItem value="getPullRequest">getPullRequest</SelectItem>
            <SelectItem value="getDifferences">getDifferences</SelectItem>
            <SelectItem value="getCommentsForPullRequest">getCommentsForPullRequest</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={stateFilter || "all"}
          onValueChange={(v) => {
            setStateFilter(v === "all" ? "" : v)
            setOffset(0)
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="State" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All states</SelectItem>
            <SelectItem value="always_allowed">Always allowed</SelectItem>
            <SelectItem value="allowed">Allowed</SelectItem>
            <SelectItem value="denied">Denied</SelectItem>
            <SelectItem value="timed_out">Timed out</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-3 py-2 text-left font-medium">Timestamp</th>
              <th className="px-3 py-2 text-left font-medium">Operation</th>
              <th className="px-3 py-2 text-left font-medium">Account</th>
              <th className="px-3 py-2 text-left font-medium">State</th>
              <th className="px-3 py-2 text-right font-medium">Duration</th>
              <th className="px-3 py-2 text-left font-medium">Context</th>
            </tr>
          </thead>
          <tbody>
            {loading && entries.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                  Loading...
                </td>
              </tr>
            )}
            {!loading && entries.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                  No entries
                </td>
              </tr>
            )}
            {entries.map((e: AuditEntry) => (
              <tr key={e.id} className="border-b last:border-0 hover:bg-muted/30">
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground whitespace-nowrap">
                  {new Date(e.timestamp).toLocaleString()}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{e.operation}</td>
                <td className="px-3 py-2 text-xs">{e.accountProfile || "-"}</td>
                <td className="px-3 py-2">
                  <Badge variant={stateBadgeVariant(e.permissionState)} className="text-xs">
                    {e.permissionState}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                  {e.durationMs != null ? `${e.durationMs}ms` : "-"}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground truncate max-w-[200px]">{e.context}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {total > 0 ? `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}` : "0 entries"}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Previous
          </Button>
          <Button variant="outline" size="sm" disabled={!hasMore} onClick={() => setOffset(offset + PAGE_SIZE)}>
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}
