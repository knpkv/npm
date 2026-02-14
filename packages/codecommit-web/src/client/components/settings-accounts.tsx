import { Result, useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { InfoIcon, LogOutIcon, SearchIcon, ServerIcon, UserIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { configQueryAtom, configSaveAtom, notificationsSsoLogoutAtom } from "../atoms/app.js"
import { Button } from "./ui/button.js"
import { Input } from "./ui/input.js"
import { Separator } from "./ui/separator.js"

type StatusFilter = "all" | "on" | "off"

interface ConfigData {
  readonly accounts: ReadonlyArray<{
    readonly profile: string
    readonly regions: ReadonlyArray<string>
    readonly enabled: boolean
  }>
  readonly autoDetect: boolean
  readonly autoRefresh: boolean
  readonly refreshIntervalSeconds: number
  readonly currentUser?: string | undefined
}

export function SettingsAccounts() {
  const config = useAtomValue(configQueryAtom)
  const saveConfig = useAtomSet(configSaveAtom)
  const ssoLogout = useAtomSet(notificationsSsoLogoutAtom)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const debounceRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    },
    []
  )

  const saveWithDebounce = useCallback(
    (payload: {
      accounts: Array<{ profile: string; regions: string[]; enabled: boolean }>
      autoDetect: boolean
      autoRefresh: boolean
      refreshIntervalSeconds: number
    }) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        saveConfig({ payload })
      }, 500)
    },
    [saveConfig]
  )

  const toggleAccount = useCallback(
    (
      profile: string,
      data: ConfigData
    ) => {
      const current = overrides[profile] ?? data.accounts.find((a) => a.profile === profile)?.enabled ?? true
      const next = !current
      const nextOverrides = { ...overrides, [profile]: next }
      setOverrides(nextOverrides)
      saveWithDebounce({
        accounts: data.accounts.map((a) => ({
          profile: a.profile,
          regions: [...a.regions],
          enabled: a.profile === profile ? next : (nextOverrides[a.profile] ?? a.enabled)
        })),
        autoDetect: data.autoDetect,
        autoRefresh: data.autoRefresh,
        refreshIntervalSeconds: data.refreshIntervalSeconds
      })
    },
    [saveWithDebounce, overrides]
  )

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Accounts</h2>
        <p className="text-sm text-muted-foreground">AWS profiles configured for CodeCommit</p>
      </div>
      <Separator />
      {Result.builder(config)
        .onInitialOrWaiting(() => <p className="text-sm text-muted-foreground">Loading...</p>)
        .onError(() => <p className="text-sm text-destructive">Failed to load config</p>)
        .onDefect(() => <p className="text-sm text-destructive">Failed to load config</p>)
        .onSuccess((data) => (
          <AccountsList
            data={data}
            overrides={overrides}
            search={search}
            setSearch={setSearch}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            toggleAccount={toggleAccount}
            onSsoLogout={() => ssoLogout({})}
          />
        ))
        .render()}
    </div>
  )
}

function AccountsList({
  data,
  onSsoLogout,
  overrides,
  search,
  setSearch,
  setStatusFilter,
  statusFilter,
  toggleAccount
}: {
  readonly data: ConfigData
  readonly overrides: Record<string, boolean>
  readonly search: string
  readonly setSearch: (s: string) => void
  readonly statusFilter: StatusFilter
  readonly setStatusFilter: (f: StatusFilter) => void
  readonly toggleAccount: (profile: string, data: ConfigData) => void
  readonly onSsoLogout: () => void
}) {
  const accounts = useMemo(
    () => data.accounts.map((a) => ({ ...a, enabled: overrides[a.profile] ?? a.enabled })),
    [data.accounts, overrides]
  )

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return accounts.filter((a) => {
      if (statusFilter === "on" && !a.enabled) return false
      if (statusFilter === "off" && a.enabled) return false
      if (q && !a.profile.toLowerCase().includes(q) && !a.regions.some((r) => r.toLowerCase().includes(q))) return false
      return true
    })
  }, [accounts, search, statusFilter])

  const enabledCount = accounts.filter((a) => a.enabled).length

  return (
    <>
      {data.currentUser && (
        <div className="flex items-center gap-2 text-sm">
          <UserIcon className="size-4 text-muted-foreground" />
          <span className="text-muted-foreground">Current user:</span>
          <span className="font-medium">{data.currentUser}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs"
            title="SSO Logout"
            onClick={() => onSsoLogout()}
          >
            <LogOutIcon className="size-3" />
          </Button>
        </div>
      )}
      {accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">
          No accounts configured. Edit the config file to add AWS profiles.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search profiles..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 pl-8 text-sm"
              />
            </div>
            <div className="flex gap-1">
              {(["all", "on", "off"] as const).map((f) => (
                <Button
                  key={f}
                  variant={statusFilter === f ? "default" : "outline"}
                  size="sm"
                  className="h-8 px-2.5 text-xs capitalize"
                  onClick={() => setStatusFilter(f)}
                >
                  {f}
                </Button>
              ))}
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            {enabledCount}/{accounts.length} enabled
            {filtered.length !== accounts.length && ` · ${filtered.length} shown`}
          </div>
          <div className="divide-y rounded-md border">
            {filtered.map((account) => (
              <div key={account.profile} className="flex items-center justify-between px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <ServerIcon className="size-3.5 text-muted-foreground shrink-0" />
                  <span className="text-sm font-medium truncate">{account.profile}</span>
                  <span className="text-xs text-muted-foreground truncate">
                    {account.regions.join(", ") || "default"}
                  </span>
                </div>
                <Button
                  variant={account.enabled ? "default" : "outline"}
                  size="sm"
                  className="ml-2 h-6 px-2 text-xs shrink-0"
                  onClick={() => toggleAccount(account.profile, data)}
                >
                  {account.enabled ? "On" : "Off"}
                </Button>
              </div>
            ))}
            {filtered.length === 0 && (
              <p className="px-3 py-4 text-center text-sm text-muted-foreground">No matching accounts</p>
            )}
          </div>
        </>
      )}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <InfoIcon className="size-3" />
        Auto-detect: {data.autoDetect ? "enabled" : "disabled"}
      </div>
    </>
  )
}
