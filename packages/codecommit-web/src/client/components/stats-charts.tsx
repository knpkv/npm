import * as DateUtils from "@knpkv/codecommit-core/DateUtils.js"
import type { WeeklyStats } from "@knpkv/codecommit-core/StatsService/WeeklyStats.js"
import { Badge } from "./ui/badge.js"
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js"

export function formatMs(ms: number | null): string {
  if (ms == null) return "—"
  return DateUtils.formatDuration(ms)
}

export function KPICard({
  icon: Icon,
  label,
  onClick,
  value
}: {
  label: string
  value: string | number
  icon: React.ComponentType<{ className?: string }>
  onClick?: () => void
}) {
  return (
    <Card className={onClick ? "cursor-pointer transition-colors hover:bg-accent/50" : undefined} onClick={onClick}>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="rounded-md bg-muted p-2">
          <Icon className="size-4 text-muted-foreground" />
        </div>
        <div>
          <div className="text-2xl font-bold tabular-nums">{value}</div>
          <div className="text-xs text-muted-foreground">{label}</div>
        </div>
      </CardContent>
    </Card>
  )
}

export function RankingChart({
  data,
  labelKey,
  onItemClick,
  title,
  valueKey
}: {
  data: ReadonlyArray<Record<string, unknown>>
  labelKey: string
  valueKey: string
  title: string
  onItemClick?: (label: string) => void
}) {
  const max = data.reduce((m, d) => Math.max(m, Number(d[valueKey]) || 0), 0)
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No data</p>
        ) : (
          <div className="space-y-1.5">
            {data.map((d) => {
              const label = String(d[labelKey])
              const value = Number(d[valueKey]) || 0
              const pct = max > 0 ? (value / max) * 100 : 0
              return (
                <div
                  key={label}
                  className={`group relative flex items-center gap-2 rounded-md px-2 py-1.5${
                    onItemClick ? " cursor-pointer" : ""
                  }`}
                  onClick={onItemClick ? () => onItemClick(label) : undefined}
                >
                  <div
                    className="absolute inset-0 rounded-md bg-foreground/[0.06] dark:bg-foreground/[0.08] transition-colors group-hover:bg-foreground/[0.10] dark:group-hover:bg-foreground/[0.14]"
                    style={{ width: `${pct}%` }}
                  />
                  <span className="relative z-10 flex-1 truncate text-xs">{label}</span>
                  <span className="relative z-10 shrink-0 text-xs tabular-nums text-muted-foreground">{value}</span>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function SizeDistributionChart({
  dist,
  onBarClick
}: {
  dist: WeeklyStats["prSizeDistribution"]
  onBarClick?: (size: string) => void
}) {
  const chartData = [
    { key: "small", label: "S", sub: "<5 files", count: dist.small },
    { key: "medium", label: "M", sub: "5–15", count: dist.medium },
    { key: "large", label: "L", sub: "15–30", count: dist.large },
    { key: "xlarge", label: "XL", sub: "30+", count: dist.extraLarge }
  ]
  const total = chartData.reduce((s, d) => s + d.count, 0)
  const max = Math.max(...chartData.map((d) => d.count), 1)
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">PR Size Distribution</CardTitle>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="text-sm text-muted-foreground">No diff data</p>
        ) : (
          <div className="flex items-end gap-2 h-[120px]">
            {chartData.map((d) => (
              <div
                key={d.key}
                className={`flex flex-1 flex-col items-center gap-1${
                  onBarClick && d.count > 0 ? " cursor-pointer" : ""
                }`}
                onClick={onBarClick && d.count > 0 ? () => onBarClick(d.key) : undefined}
              >
                <span className="text-xs tabular-nums text-muted-foreground">{d.count}</span>
                <div className="w-full flex items-end" style={{ height: 80 }}>
                  <div
                    className="w-full rounded-t bg-foreground/[0.12] dark:bg-foreground/[0.16] transition-all hover:bg-foreground/[0.18] dark:hover:bg-foreground/[0.22]"
                    style={{ height: `${(d.count / max) * 100}%`, minHeight: d.count > 0 ? 4 : 0 }}
                  />
                </div>
                <div className="text-center">
                  <div className="text-xs font-medium">{d.label}</div>
                  <div className="text-[10px] text-muted-foreground">{d.sub}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function MostActivePRs({
  onPRClick,
  prs
}: {
  prs: WeeklyStats["mostActivePRs"]
  onPRClick: (awsAccountId: string, id: string) => void
}) {
  if (prs.length === 0) return null
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Most Active PRs</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {prs.map((pr) => (
            <div
              key={`${pr.awsAccountId}:${pr.id}`}
              className="flex items-center gap-2 text-sm cursor-pointer hover:bg-accent rounded px-2 py-1"
              onClick={() => onPRClick(pr.awsAccountId, pr.id)}
            >
              <span className="text-muted-foreground font-mono">#{pr.id}</span>
              <span className="truncate flex-1">{pr.title}</span>
              <span className="text-muted-foreground text-xs">{pr.author}</span>
              <Badge variant="secondary" className="text-xs">
                {pr.repositoryName}
              </Badge>
              <span className="text-xs tabular-nums">{pr.commentCount} comments</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

export function StalePRs({
  onPRClick,
  prs
}: {
  prs: WeeklyStats["stalePRs"]
  onPRClick: (awsAccountId: string, id: string) => void
}) {
  if (prs.length === 0) return null
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-1">Stale PRs</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          {prs.map((pr) => (
            <div
              key={`${pr.awsAccountId}:${pr.id}`}
              className="flex items-center gap-2 text-sm cursor-pointer hover:bg-accent rounded px-2 py-1"
              onClick={() => onPRClick(pr.awsAccountId, pr.id)}
            >
              <span className="text-muted-foreground font-mono">#{pr.id}</span>
              <span className="truncate flex-1">{pr.title}</span>
              <span className="text-muted-foreground text-xs">{pr.author}</span>
              <Badge variant="destructive" className="text-xs">
                {pr.daysSinceActivity}d idle
              </Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

export function HealthCard({ data }: { data: WeeklyStats }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Health</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-4 gap-4">
          <div>
            <div className="text-xs text-muted-foreground">Review Coverage</div>
            <div className="text-lg font-bold tabular-nums">
              {data.reviewCoverage != null ? `${(data.reviewCoverage * 100).toFixed(0)}%` : "—"}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Approval Rate</div>
            <div className="text-lg font-bold tabular-nums">
              {data.approvalRate != null ? `${(data.approvalRate * 100).toFixed(0)}%` : "—"}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Stale PRs</div>
            <div className="text-lg font-bold tabular-nums">{data.stalePRs.length}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Bus Factor</div>
            <div className="text-lg font-bold tabular-nums">
              {data.busFactor
                ? `${data.busFactor.uniqueContributors} (${(data.busFactor.topContributorShare * 100).toFixed(0)}%)`
                : "—"}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
