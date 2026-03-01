import { useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { SandboxId } from "@knpkv/codecommit-core/Domain.js"
import { BoxIcon, LoaderIcon, PlayIcon, ScrollTextIcon, SquareIcon, Trash2Icon } from "lucide-react"
import { useNavigate } from "react-router"
import { appStateAtom, deleteSandboxAtom, restartSandboxAtom, stopSandboxAtom } from "../atoms/app.js"
import { Badge } from "./ui/badge.js"
import { Button } from "./ui/button.js"

const statusVariant = (status: string) => {
  switch (status) {
    case "running":
      return "default" as const
    case "creating":
    case "cloning":
    case "starting":
      return "secondary" as const
    case "error":
      return "destructive" as const
    default:
      return "outline" as const
  }
}

const isActive = (status: string) => ["creating", "cloning", "starting", "running"].includes(status)

const formatTime = (ts: string) => {
  const d = new Date(ts)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

export function SandboxesPage() {
  const state = useAtomValue(appStateAtom)
  const stopSandbox = useAtomSet(stopSandboxAtom)
  const restartSandbox = useAtomSet(restartSandboxAtom)
  const deleteSandbox = useAtomSet(deleteSandboxAtom)
  const navigate = useNavigate()
  const sandboxes = state.sandboxes ?? []

  if (sandboxes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20 text-muted-foreground">
        <BoxIcon className="size-8 opacity-30" />
        <p className="text-sm">No sandboxes</p>
        <p className="text-xs">Open a PR and press "." or click "Sandbox" to create one</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Sandboxes</h1>
        <span className="text-xs text-muted-foreground">{sandboxes.length} total</span>
      </div>

      <div className="space-y-2">
        {sandboxes.map((s) => (
          <div
            key={s.id}
            className="rounded-lg border bg-card px-4 py-3 hover:bg-accent/50 cursor-pointer"
            onClick={() => navigate(`/sandbox/${s.id}`)}
          >
            <div className="flex items-center gap-3">
              {isActive(s.status) && s.status !== "running" ? (
                <LoaderIcon className="size-4 animate-spin text-muted-foreground shrink-0" />
              ) : (
                <BoxIcon className="size-4 text-muted-foreground shrink-0" />
              )}

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm truncate">{s.repositoryName}</span>
                  <Badge variant="outline" className="font-mono text-[10px] shrink-0">
                    {s.sourceBranch}
                  </Badge>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                  <span>PR #{s.pullRequestId}</span>
                  <span>·</span>
                  <span>{formatTime(s.createdAt)}</span>
                  {s.port && s.status === "running" && (
                    <>
                      <span>·</span>
                      <span>port {s.port}</span>
                    </>
                  )}
                  {s.statusDetail && isActive(s.status) && s.status !== "running" && (
                    <>
                      <span>·</span>
                      <span className="truncate">{s.statusDetail}</span>
                    </>
                  )}
                </div>
              </div>

              <Badge variant={statusVariant(s.status)} className="shrink-0">
                {s.status}
              </Badge>

              {s.logs && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    navigate(`/sandbox/${s.id}?view=logs`)
                  }}
                >
                  <ScrollTextIcon className="size-3.5" />
                </Button>
              )}
              {(s.status === "running" || isActive(s.status)) && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    stopSandbox({ path: { sandboxId: SandboxId.make(s.id) } })
                  }}
                >
                  <SquareIcon className="size-3" />
                </Button>
              )}
              {(s.status === "stopped" || s.status === "error") && s.containerId && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    restartSandbox({ path: { sandboxId: SandboxId.make(s.id) } })
                  }}
                >
                  <PlayIcon className="size-3.5" />
                </Button>
              )}
              {(s.status === "stopped" || s.status === "error") && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteSandbox({ path: { sandboxId: SandboxId.make(s.id) } })
                  }}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              )}
            </div>
            {s.error && (
              <p className="mt-2 rounded bg-destructive/10 px-3 py-1.5 text-xs text-destructive font-mono break-all">
                {s.error}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
