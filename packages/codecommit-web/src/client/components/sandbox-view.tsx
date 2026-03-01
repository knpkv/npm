import { useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { SandboxId } from "@knpkv/codecommit-core/Domain.js"
import { ArrowLeftIcon, CodeIcon, LoaderIcon, PlayIcon, ScrollTextIcon, SquareIcon, Trash2Icon } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router"
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

function LogPanel({ logs }: { readonly logs: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [logs])

  const lines = logs.trimEnd().split("\n")
  return (
    <div
      ref={ref}
      className="flex-1 min-h-0 overflow-y-auto bg-black/40 rounded-lg p-4 font-mono text-xs leading-relaxed"
    >
      {lines.map((line, i) => {
        const match = line.match(/^\[([^\]]+)\]\s*(.*)$/)
        if (!match)
          return (
            <div key={i} className="text-muted-foreground">
              {line}
            </div>
          )
        const [, ts, msg] = match
        return (
          <div key={i} className="flex gap-3">
            <span className="text-muted-foreground/50 shrink-0 select-none">{ts}</span>
            <span className="text-muted-foreground">{msg}</span>
          </div>
        )
      })}
    </div>
  )
}

export function SandboxView() {
  const { sandboxId } = useParams<{ sandboxId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const state = useAtomValue(appStateAtom)
  const stopSandbox = useAtomSet(stopSandboxAtom)
  const restartSandbox = useAtomSet(restartSandboxAtom)
  const deleteSandbox = useAtomSet(deleteSandboxAtom)
  const navigate = useNavigate()

  const viewFromUrl = searchParams.get("view")
  const [showLogs, setShowLogs] = useState(viewFromUrl === "logs")

  const toggleLogs = useCallback(() => {
    setShowLogs((prev) => {
      const next = !prev
      setSearchParams(next ? { view: "logs" } : {}, { replace: true })
      return next
    })
  }, [setSearchParams])

  const sandbox = useMemo(() => state.sandboxes?.find((s) => s.id === sandboxId) ?? null, [state.sandboxes, sandboxId])

  const handleStop = useCallback(() => {
    if (!sandboxId) return
    stopSandbox({ path: { sandboxId: SandboxId.make(sandboxId) } })
  }, [sandboxId, stopSandbox])

  const backUrl = sandbox ? `/accounts/${sandbox.awsAccountId}/prs/${sandbox.pullRequestId}` : "/"

  if (!sandbox) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20 text-muted-foreground">
        <LoaderIcon className="size-6 animate-spin opacity-40" />
        <p className="text-sm">Loading sandbox...</p>
      </div>
    )
  }

  const isRunning = sandbox.status === "running"
  const isActive = ["creating", "cloning", "starting"].includes(sandbox.status)

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b shrink-0">
        <Button variant="ghost" size="sm" onClick={() => navigate(backUrl)}>
          <ArrowLeftIcon className="size-4" />
          Back to PR
        </Button>
        <Badge variant="outline" className="font-mono text-xs">
          {sandbox.repositoryName}
        </Badge>
        <Badge variant="secondary" className="font-mono text-xs">
          {sandbox.sourceBranch}
        </Badge>
        <div className="ml-auto flex items-center gap-1.5">
          {isActive && <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />}
          <Badge variant={statusVariant(sandbox.status)} className="mr-1">
            {sandbox.status}
          </Badge>
          {sandbox.logs && (
            <Button variant={showLogs ? "secondary" : "outline"} size="sm" onClick={toggleLogs}>
              {showLogs ? (
                <>
                  <CodeIcon className="size-3.5" /> Editor
                </>
              ) : (
                <>
                  <ScrollTextIcon className="size-3.5" /> Logs
                </>
              )}
            </Button>
          )}
          {(sandbox.status === "stopped" || sandbox.status === "error") && sandbox.containerId && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => sandboxId && restartSandbox({ path: { sandboxId: SandboxId.make(sandboxId) } })}
            >
              <PlayIcon className="size-3" />
              Restart
            </Button>
          )}
          {(sandbox.status === "stopped" || sandbox.status === "error") && (
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                if (!sandboxId) return
                deleteSandbox({ path: { sandboxId: SandboxId.make(sandboxId) } })
                navigate("/sandboxes")
              }}
            >
              <Trash2Icon className="size-3" />
              Delete
            </Button>
          )}
          {(isActive || isRunning) && (
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={handleStop}
            >
              <SquareIcon className="size-3" />
              Stop
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      {showLogs || !isRunning ? (
        <div className="flex-1 min-h-0 flex flex-col gap-3 p-4">
          {sandbox.statusDetail && <p className="text-sm text-muted-foreground shrink-0">{sandbox.statusDetail}</p>}
          {sandbox.error && (
            <p className="rounded bg-destructive/10 px-3 py-2 text-xs text-destructive font-mono break-all shrink-0">
              {sandbox.error}
            </p>
          )}
          {sandbox.logs ? (
            <LogPanel logs={sandbox.logs} />
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              No logs available
            </div>
          )}
        </div>
      ) : (
        <iframe src={`http://localhost:${sandbox.port}/`} className="flex-1 w-full border-0" title="Code Sandbox" />
      )}
    </div>
  )
}
