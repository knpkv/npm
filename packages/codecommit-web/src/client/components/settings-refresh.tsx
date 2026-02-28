import { Result, useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { RefreshCwIcon } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { configQueryAtom, configSaveAtom } from "../atoms/app.js"
import { Button, ButtonGroup } from "./ui/button.js"
import { Separator } from "./ui/separator.js"

const INTERVAL_OPTIONS = [
  { label: "1 min", value: 60 },
  { label: "5 min", value: 300 },
  { label: "10 min", value: 600 },
  { label: "15 min", value: 900 },
  { label: "30 min", value: 1800 }
] as const

interface RefreshConfig {
  autoRefresh: boolean
  refreshIntervalSeconds: number
}

export function SettingsRefresh() {
  const config = useAtomValue(configQueryAtom)
  const saveConfig = useAtomSet(configSaveAtom)
  const channelRef = useRef<BroadcastChannel | null>(null)
  type ConfigValue = Extract<typeof config, { readonly _tag: "Success" }>["value"]
  const configRef = useRef<ConfigValue | null>(null)
  const [local, setLocal] = useState<Partial<RefreshConfig>>({})

  useEffect(() => {
    if (Result.isSuccess(config)) {
      configRef.current = config.value
    }
  }, [config])

  // BroadcastChannel — external system subscription
  useEffect(() => {
    const bc = new BroadcastChannel("codecommit-config")
    channelRef.current = bc
    bc.onmessage = (e: MessageEvent<Partial<RefreshConfig>>) => {
      setLocal((prev) => ({ ...prev, ...e.data }))
    }
    return () => bc.close()
  }, [])

  const save = useCallback(
    (patch: Partial<RefreshConfig>) => {
      const data = configRef.current
      if (!data) return
      setLocal((prev) => ({ ...prev, ...patch }))
      channelRef.current?.postMessage(patch)
      saveConfig({
        payload: {
          accounts: data.accounts.map((a) => ({
            profile: a.profile,
            regions: [...a.regions],
            enabled: a.enabled
          })),
          autoDetect: data.autoDetect,
          autoRefresh: patch.autoRefresh ?? data.autoRefresh,
          refreshIntervalSeconds: patch.refreshIntervalSeconds ?? data.refreshIntervalSeconds
        }
      })
    },
    [saveConfig]
  )

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Auto-refresh</h2>
        <p className="text-sm text-muted-foreground">Periodically fetch PR updates from AWS</p>
      </div>
      <Separator />
      {Result.builder(config)
        .onInitialOrWaiting(() => <p className="text-sm text-muted-foreground">Loading...</p>)
        .onError(() => <p className="text-sm text-destructive">Failed to load config</p>)
        .onDefect(() => <p className="text-sm text-destructive">Failed to load config</p>)
        .onSuccess((data) => {
          const autoRefresh = local.autoRefresh ?? data.autoRefresh
          const interval = local.refreshIntervalSeconds ?? data.refreshIntervalSeconds
          return (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm">
                  <RefreshCwIcon className="size-4 text-muted-foreground" />
                  <span>Auto-refresh</span>
                </div>
                <Button
                  variant={autoRefresh ? "default" : "outline"}
                  size="sm"
                  className="h-7 px-3 text-xs"
                  onClick={() => save({ autoRefresh: !autoRefresh })}
                >
                  {autoRefresh ? "On" : "Off"}
                </Button>
              </div>
              {autoRefresh && (
                <div className="space-y-2">
                  <span className="text-sm text-muted-foreground">Refresh interval</span>
                  <ButtonGroup>
                    {INTERVAL_OPTIONS.map((opt) => (
                      <Button
                        key={opt.value}
                        variant={interval === opt.value ? "default" : "outline"}
                        size="sm"
                        className="h-7 px-3 text-xs"
                        onClick={() => save({ refreshIntervalSeconds: opt.value })}
                      >
                        {opt.label}
                      </Button>
                    ))}
                  </ButtonGroup>
                </div>
              )}
            </div>
          )
        })
        .render()}
    </div>
  )
}
