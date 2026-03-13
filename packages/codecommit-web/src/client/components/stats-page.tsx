import { Result, useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import * as DateUtils from "@knpkv/codecommit-core/DateUtils.js"
import type { WeeklyStats } from "@knpkv/codecommit-core/StatsService/WeeklyStats.js"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CalendarIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  GitPullRequestIcon,
  LoaderIcon,
  MessageSquareIcon,
  RefreshCwIcon
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useSearchParams } from "react-router"
import { appStateAtom, statsSyncAtom } from "../atoms/app.js"
import { useWeeklyStats } from "../hooks/useWeeklyStats.js"
import {
  formatMs,
  HealthCard,
  KPICard,
  MostActivePRs,
  RankingChart,
  SizeDistributionChart,
  StalePRs
} from "./stats-charts.js"
import { Badge } from "./ui/badge.js"
import { Button } from "./ui/button.js"
import { Card, CardContent } from "./ui/card.js"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.js"
import { Separator } from "./ui/separator.js"

function StatsFilters({
  author,
  data,
  repo,
  setFilter
}: {
  data: WeeklyStats
  repo: string | undefined
  author: string | undefined
  setFilter: (key: string, value: string | undefined) => void
}) {
  return (
    <>
      {data.availableRepos.length > 0 && (
        <Select value={repo || "__all__"} onValueChange={(v) => setFilter("repo", v === "__all__" ? undefined : v)}>
          <SelectTrigger className="w-[140px] h-8 text-xs">
            <SelectValue placeholder="All repos" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All repos</SelectItem>
            {data.availableRepos.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {data.availableAuthors.length > 0 && (
        <Select value={author || "__all__"} onValueChange={(v) => setFilter("author", v === "__all__" ? undefined : v)}>
          <SelectTrigger className="w-[140px] h-8 text-xs">
            <SelectValue placeholder="All authors" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All authors</SelectItem>
            {data.availableAuthors.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </>
  )
}

type LifecycleDetail = WeeklyStats["mergeTimeDetails"][number]

function LifecycleDetailTable({
  details,
  goToPR
}: {
  details: ReadonlyArray<LifecycleDetail>
  goToPR: (awsAccountId: string, id: string) => void
}) {
  if (details.length === 0) return <p className="text-xs text-muted-foreground py-2">No data points</p>
  return (
    <div className="space-y-1 mt-2">
      {details.map((d, i) => (
        <div
          key={`${d.awsAccountId}:${d.prId}:${i}`}
          className="flex items-center gap-2 text-xs cursor-pointer hover:bg-accent rounded px-2 py-1"
          onClick={() => goToPR(d.awsAccountId, d.prId)}
        >
          <span className="text-muted-foreground font-mono shrink-0">#{d.prId}</span>
          <span className="truncate flex-1">{d.prTitle}</span>
          <span className="text-muted-foreground shrink-0">{d.author}</span>
          <Badge variant="secondary" className="text-[10px] shrink-0">
            {d.repositoryName}
          </Badge>
          <span className="font-mono tabular-nums shrink-0">{formatMs(d.durationMs)}</span>
          <span className="text-muted-foreground shrink-0 text-[10px]">
            {d.fromLabel} → {d.toLabel}
          </span>
        </div>
      ))}
    </div>
  )
}

function LifecycleMetrics({ data, goToPR }: { data: WeeklyStats; goToPR: (awsAccountId: string, id: string) => void }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const toggle = (key: string) => setExpanded((prev) => (prev === key ? null : key))

  const metrics = [
    { key: "merge", label: "Median Time to Merge", value: data.medianTimeToMerge, details: data.mergeTimeDetails },
    {
      key: "review",
      label: "Median Time to First Review",
      value: data.medianTimeToFirstReview,
      details: data.firstReviewDetails
    },
    {
      key: "feedback",
      label: "Median Time to Address Feedback",
      value: data.medianTimeToAddressFeedback,
      details: data.feedbackDetails
    }
  ] as const

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-3">
        {metrics.map((m) => (
          <Card
            key={m.key}
            className={`cursor-pointer transition-colors hover:bg-accent/50 ${
              expanded === m.key ? "ring-1 ring-ring" : ""
            }`}
            onClick={() => toggle(m.key)}
          >
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div className="text-xs text-muted-foreground">{m.label}</div>
                <ChevronDownIcon
                  className={`size-3 text-muted-foreground transition-transform ${
                    expanded === m.key ? "rotate-180" : ""
                  }`}
                />
              </div>
              <div className="flex items-baseline gap-2">
                <div className="text-xl font-bold tabular-nums">{formatMs(m.value)}</div>
                {m.details.length > 0 && (
                  <span className="text-[10px] text-muted-foreground">{m.details.length} PRs</span>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {expanded && (
        <Card>
          <CardContent className="p-3">
            <div className="text-xs font-medium mb-1">{metrics.find((m) => m.key === expanded)?.label} — Detail</div>
            <LifecycleDetailTable details={metrics.find((m) => m.key === expanded)?.details ?? []} goToPR={goToPR} />
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function StatsContent({
  data,
  goToPR,
  handleSync,
  navigate,
  syncing
}: {
  data: WeeklyStats
  navigate: (path: string) => void
  goToPR: (awsAccountId: string, id: string) => void
  handleSync: () => void
  syncing: boolean
}) {
  return (
    <div className="space-y-4">
      {/* KPI Row */}
      <div className="grid grid-cols-3 gap-3">
        <KPICard
          label="PRs Created"
          value={data.prsCreated}
          icon={GitPullRequestIcon}
          onClick={() => navigate(`/?from=${data.weekStart.slice(0, 10)}&to=${data.weekEnd.slice(0, 10)}`)}
        />
        <KPICard
          label="PRs Merged"
          value={data.prsMerged}
          icon={GitPullRequestIcon}
          onClick={() =>
            navigate(`/?f=status:merged&from=${data.weekStart.slice(0, 10)}&to=${data.weekEnd.slice(0, 10)}`)
          }
        />
        <KPICard label="Comments" value={data.totalComments} icon={MessageSquareIcon} />
      </div>

      {/* Lifecycle metrics */}
      <LifecycleMetrics data={data} goToPR={goToPR} />

      {/* Contributors + Reviewers + Approvers */}
      <div className="grid grid-cols-3 gap-3">
        <RankingChart
          data={data.topContributors}
          labelKey="author"
          valueKey="prCount"
          title="Top Contributors"
          onItemClick={(name) =>
            navigate(
              `/?f=author:${encodeURIComponent(name)}&from=${data.weekStart.slice(0, 10)}&to=${data.weekEnd.slice(
                0,
                10
              )}`
            )
          }
        />
        <RankingChart
          data={data.topReviewers}
          labelKey="author"
          valueKey="commentCount"
          title="Top Commenters"
          onItemClick={(name) =>
            navigate(
              `/?f=commenter:${encodeURIComponent(name)}&from=${data.weekStart.slice(0, 10)}&to=${data.weekEnd.slice(
                0,
                10
              )}`
            )
          }
        />
        <RankingChart
          data={data.topApprovers}
          labelKey="author"
          valueKey="approvalCount"
          title="Top Approvers"
          onItemClick={(name) =>
            navigate(
              `/?f=approver:${encodeURIComponent(name)}&from=${data.weekStart.slice(0, 10)}&to=${data.weekEnd.slice(
                0,
                10
              )}`
            )
          }
        />
      </div>

      {/* PR Size + Diff by contributor */}
      <div className="grid grid-cols-2 gap-3">
        <SizeDistributionChart
          dist={data.prSizeDistribution}
          onBarClick={(size) =>
            navigate(`/?f=size:${size}&from=${data.weekStart.slice(0, 10)}&to=${data.weekEnd.slice(0, 10)}`)
          }
        />
        {data.avgDiffSize && (
          <Card>
            <CardContent className="space-y-2 p-4">
              <div className="text-sm font-medium">Average Diff Size</div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Files added</span>
                <span className="font-mono">{data.avgDiffSize.filesAdded.toFixed(1)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Files modified</span>
                <span className="font-mono">{data.avgDiffSize.filesModified.toFixed(1)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Files deleted</span>
                <span className="font-mono">{data.avgDiffSize.filesDeleted.toFixed(1)}</span>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <MostActivePRs prs={data.mostActivePRs} onPRClick={goToPR} />

      <HealthCard data={data} />

      <StalePRs prs={data.stalePRs} onPRClick={goToPR} />

      {/* Data completeness */}
      {data.dataAvailableSince && (
        <div className="text-xs text-muted-foreground text-center py-2">
          Data available since {DateUtils.formatDate(new Date(data.dataAvailableSince))}
        </div>
      )}

      {data.prsCreated === 0 && data.prsMerged === 0 && data.totalComments === 0 && (
        <div className="text-center py-8 text-muted-foreground">
          <p className="text-sm">No activity for this week.</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={handleSync} disabled={syncing}>
            <RefreshCwIcon className={`size-3 mr-1 ${syncing ? "animate-spin" : ""}`} />
            Sync this week
          </Button>
        </div>
      )}
    </div>
  )
}

export function StatsPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const syncWeek = useAtomSet(statsSyncAtom)

  const currentWeek = useMemo(() => DateUtils.toISOWeek(new Date()), [])
  const week = searchParams.get("week") || currentWeek

  const repo = searchParams.get("repo") || undefined
  const author = searchParams.get("author") || undefined
  const account = searchParams.get("account") || undefined

  const statsResult = useWeeklyStats(week, { repo, author, account })

  const appState = useAtomValue(appStateAtom)
  const syncing = appState.status === "loading"
  const prevSyncingRef = useRef(syncing)

  // Auto-refresh stats when sync transitions loading → idle
  useEffect(() => {
    if (prevSyncingRef.current && !syncing) {
      setSearchParams((p) => {
        p.set("_t", Date.now().toString())
        return p
      })
    }
    prevSyncingRef.current = syncing
  }, [syncing, setSearchParams])

  const weekRange = useMemo(() => DateUtils.parseISOWeek(week), [week])
  const weekLabel = useMemo(() => {
    if (weekRange._tag === "None") return week
    return DateUtils.formatWeekLabel(weekRange.value)
  }, [week, weekRange])

  const navigateWeek = useCallback(
    (delta: number) => {
      if (weekRange._tag === "None") return
      const newStart = new Date(weekRange.value.start.getTime() + delta * 7 * 86400000)
      const newWeek = DateUtils.toISOWeek(newStart)
      if (newWeek > currentWeek) return
      setSearchParams((p) => {
        p.set("week", newWeek)
        return p
      })
    },
    [weekRange, currentWeek, setSearchParams]
  )

  const setFilter = useCallback(
    (key: string, value: string | undefined) => {
      setSearchParams((p) => {
        if (value) p.set(key, value)
        else p.delete(key)
        return p
      })
    },
    [setSearchParams]
  )

  const handleSync = useCallback(() => {
    syncWeek({ payload: { week } })
  }, [week, syncWeek])

  const goToPR = useCallback(
    (awsAccountId: string, id: string) => navigate(`/accounts/${awsAccountId}/prs/${id}`),
    [navigate]
  )

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate("/")}>
          <ChevronLeftIcon className="size-4" />
        </Button>
        <h1 className="text-lg font-semibold">Statistics</h1>
        <Badge variant="secondary" className="text-[10px] tracking-wide uppercase font-normal text-muted-foreground/60">
          🚧 Experimental
        </Badge>
      </div>

      {/* Week picker */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="ghost" size="icon-sm" onClick={() => navigateWeek(-1)}>
          <ArrowLeftIcon className="size-4" />
        </Button>
        <span className="text-sm font-medium min-w-[220px] text-center">{weekLabel}</span>
        <Button variant="ghost" size="icon-sm" onClick={() => navigateWeek(1)} disabled={week >= currentWeek}>
          <ArrowRightIcon className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setSearchParams((p) => {
              p.set("week", currentWeek)
              return p
            })
          }
          disabled={week === currentWeek}
        >
          <CalendarIcon className="size-3 mr-1" /> Today
        </Button>

        <div className="ml-auto flex items-center gap-2">
          {Result.builder(statsResult)
            .onSuccess((data) => <StatsFilters data={data} repo={repo} author={author} setFilter={setFilter} />)
            .render()}

          <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing}>
            <RefreshCwIcon className={`size-3 mr-1 ${syncing ? "animate-spin" : ""}`} />
            Sync
          </Button>
        </div>
      </div>

      {syncing && appState.statusDetail && (
        <div className="text-xs text-muted-foreground truncate">{appState.statusDetail}</div>
      )}

      {/* Active filters */}
      {(repo || author || account) && (
        <div className="flex gap-1 flex-wrap">
          {repo && (
            <Badge variant="secondary" className="cursor-pointer" onClick={() => setFilter("repo", undefined)}>
              repo: {repo} ×
            </Badge>
          )}
          {author && (
            <Badge variant="secondary" className="cursor-pointer" onClick={() => setFilter("author", undefined)}>
              author: {author} ×
            </Badge>
          )}
          {account && (
            <Badge variant="secondary" className="cursor-pointer" onClick={() => setFilter("account", undefined)}>
              account: {account} ×
            </Badge>
          )}
        </div>
      )}

      <Separator />

      {Result.builder(statsResult)
        .onInitialOrWaiting(() => (
          <div className="flex items-center justify-center py-12">
            <LoaderIcon className="size-5 animate-spin text-muted-foreground" />
          </div>
        ))
        .onError(() => <div className="text-sm text-destructive py-4">Failed to load stats</div>)
        .onDefect(() => <div className="text-sm text-destructive py-4">Failed to load stats</div>)
        .onSuccess((data) => (
          <StatsContent data={data} navigate={navigate} goToPR={goToPR} handleSync={handleSync} syncing={syncing} />
        ))
        .render()}
    </div>
  )
}
