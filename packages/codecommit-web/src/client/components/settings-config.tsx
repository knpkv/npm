import { Result, useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { CheckCircleIcon, CopyIcon, RotateCcwIcon, XCircleIcon } from "lucide-react"
import { useCallback, useState } from "react"
import { configPathQueryAtom, configResetAtom, configValidateQueryAtom } from "../atoms/app.js"
import { cn } from "../lib/utils.js"
import { Button } from "./ui/button.js"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.js"
import { Separator } from "./ui/separator.js"

export function SettingsConfig() {
  const configPath = useAtomValue(configPathQueryAtom)
  const validation = useAtomValue(configValidateQueryAtom)
  const resetConfig = useAtomSet(configResetAtom)
  const [copied, setCopied] = useState(false)
  const [resetting, setResetting] = useState(false)

  const copyPath = useCallback((path: string) => {
    navigator.clipboard.writeText(path)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [])

  const handleReset = useCallback(async () => {
    setResetting(true)
    try {
      await resetConfig({})
    } finally {
      setResetting(false)
    }
  }, [resetConfig])

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Configuration</h2>
        <p className="text-sm text-muted-foreground">Config file location and status</p>
      </div>
      <Separator />

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Config File</CardTitle>
        </CardHeader>
        <CardContent className="pb-3">
          {Result.builder(configPath)
            .onInitialOrWaiting(() => <span className="text-sm text-muted-foreground">Loading...</span>)
            .onError(() => <span className="text-sm text-destructive">Failed to load config path</span>)
            .onDefect(() => <span className="text-sm text-destructive">Failed to load config path</span>)
            .onSuccess((data) => (
              <div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded bg-muted px-2 py-1 text-xs font-mono">{data.path}</code>
                  <Button variant="ghost" size="icon-sm" onClick={() => copyPath(data.path)}>
                    {copied ? <CheckCircleIcon className="size-4 text-green-500" /> : <CopyIcon className="size-4" />}
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {data.exists ? "File exists" : "File does not exist yet"}
                </p>
              </div>
            ))
            .render()}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Validation</CardTitle>
        </CardHeader>
        <CardContent className="pb-3">
          {Result.builder(validation)
            .onInitialOrWaiting(() => <span className="text-sm text-muted-foreground">Loading...</span>)
            .onError(() => <span className="text-sm text-destructive">Failed to validate config</span>)
            .onDefect(() => <span className="text-sm text-destructive">Failed to validate config</span>)
            .onSuccess((data) => (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  {data.status === "valid" ? (
                    <CheckCircleIcon className="size-4 text-green-500" />
                  ) : (
                    <XCircleIcon className="size-4 text-destructive" />
                  )}
                  <span className="text-sm capitalize">{data.status}</span>
                </div>
                {data.errors.length > 0 && (
                  <div className="rounded bg-destructive/10 p-2 text-xs text-destructive">
                    {data.errors.map((e: string, i: number) => (
                      <p key={i}>{e}</p>
                    ))}
                  </div>
                )}
              </div>
            ))
            .render()}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Reset to Defaults</CardTitle>
          <CardDescription className="text-xs">
            Creates a backup of current config, then re-detects AWS profiles
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-3">
          <Button variant="outline" size="sm" onClick={handleReset} disabled={resetting} className="gap-2">
            <RotateCcwIcon className={cn("size-4", resetting && "animate-spin")} />
            {resetting ? "Resetting..." : "Reset Configuration"}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
