import { Result, useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import * as DateUtils from "@knpkv/codecommit-core/DateUtils.js"
import { CheckCircleIcon, CopyIcon, RotateCcwIcon } from "lucide-react"
import { useCallback, useState } from "react"
import { configPathQueryAtom, configResetAtom, configValidateQueryAtom, databaseInfoQueryAtom } from "../atoms/app.js"
import { cn } from "../lib/utils.js"
import { Button } from "./ui/button.js"
import { Separator } from "./ui/separator.js"

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function PathRow({
  copyKey,
  copied,
  label,
  onCopy,
  path,
  detail
}: {
  readonly label: string
  readonly path: string
  readonly detail: string
  readonly copyKey: string
  readonly copied: string | null
  readonly onCopy: (path: string, key: string) => void
}) {
  return (
    <div className="flex items-baseline gap-3 py-1.5">
      <span className="shrink-0 text-xs text-muted-foreground w-24">{label}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <code className="truncate text-xs font-mono">{path}</code>
          <button onClick={() => onCopy(path, copyKey)} className="shrink-0 rounded p-0.5 hover:bg-muted">
            {copied === copyKey ? (
              <CheckCircleIcon className="size-3 text-green-500" />
            ) : (
              <CopyIcon className="size-3 text-muted-foreground" />
            )}
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground">{detail}</p>
      </div>
    </div>
  )
}

export function SettingsConfig() {
  const configPath = useAtomValue(configPathQueryAtom)
  const validation = useAtomValue(configValidateQueryAtom)
  const databaseInfo = useAtomValue(databaseInfoQueryAtom)
  const resetConfig = useAtomSet(configResetAtom)
  const [copied, setCopied] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)

  const copyPath = useCallback((path: string, key: string) => {
    navigator.clipboard.writeText(path).then(
      () => {
        setCopied(key)
        setTimeout(() => setCopied(null), 2000)
      },
      () => {}
    )
  }, [])

  const handleReset = useCallback(async () => {
    setResetting(true)
    try {
      await resetConfig({})
    } finally {
      setResetting(false)
    }
  }, [resetConfig])

  const fmtModified = (iso?: string) =>
    iso ? `Modified ${DateUtils.formatRelativeTime(new Date(iso), new Date(), "").trim()}` : ""

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Configuration</h2>
        <p className="text-sm text-muted-foreground">File locations, validation, and storage</p>
      </div>
      <Separator />

      <div className="space-y-1">
        {Result.builder(configPath)
          .onInitialOrWaiting(() => <p className="text-xs text-muted-foreground py-1">Loading config path...</p>)
          .onError(() => <p className="text-xs text-destructive py-1">Failed to load config path</p>)
          .onDefect(() => <p className="text-xs text-destructive py-1">Failed to load config path</p>)
          .onSuccess((data) => {
            const validationDetail = Result.isSuccess(validation) ? ` · ${validation.value.status}` : ""
            const detail = data.exists
              ? `${fmtModified(data.modifiedAt)}${validationDetail}`
              : `Not created yet${validationDetail}`
            return (
              <PathRow
                label="Config file"
                path={data.path}
                detail={detail}
                copyKey="config"
                copied={copied}
                onCopy={copyPath}
              />
            )
          })
          .render()}

        {Result.builder(validation)
          .onInitialOrWaiting(() => null)
          .onError(() => null)
          .onDefect(() => null)
          .onSuccess((v) =>
            v.errors.length > 0 ? (
              <div className="ml-27 rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
                {v.errors.map((e: string, i: number) => (
                  <p key={i}>{e}</p>
                ))}
              </div>
            ) : null
          )
          .render()}

        <Separator />

        {Result.builder(databaseInfo)
          .onInitialOrWaiting(() => <p className="text-xs text-muted-foreground py-1">Loading database info...</p>)
          .onError(() => <p className="text-xs text-destructive py-1">Failed to load database info</p>)
          .onDefect(() => <p className="text-xs text-destructive py-1">Failed to load database info</p>)
          .onSuccess((data) => {
            const detail = data.exists
              ? `${formatBytes(data.sizeBytes)} · ${fmtModified(data.modifiedAt)}`
              : "Not created yet"
            return (
              <PathRow
                label="Cache database"
                path={data.path}
                detail={detail}
                copyKey="db"
                copied={copied}
                onCopy={copyPath}
              />
            )
          })
          .render()}
      </div>

      <Separator />

      <div className="flex items-center gap-3">
        <div className="flex-1">
          <p className="text-sm font-medium">Reset to Defaults</p>
          <p className="text-[11px] text-muted-foreground">Backs up current config, then re-detects AWS profiles</p>
        </div>
        <Button variant="outline" size="sm" onClick={handleReset} disabled={resetting} className="shrink-0 gap-2">
          <RotateCcwIcon className={cn("size-3.5", resetting && "animate-spin")} />
          {resetting ? "Resetting..." : "Reset"}
        </Button>
      </div>
    </div>
  )
}
