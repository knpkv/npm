import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { AwsProfileName } from "@knpkv/codecommit-core/Domain.js"
import { Schema } from "effect"
import * as Cause from "effect/Cause"
import * as Predicate from "effect/Predicate"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { LogInIcon, LogOutIcon, SearchIcon, UserIcon } from "lucide-react"
import { StatePanel } from "@knpkv/rly/primitives"
import switchStyles from "./settings-accounts.module.css"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  appStateAtom,
  configPathQueryAtom,
  configQueryAtom,
  configSaveAtom,
  notificationsSsoLoginAtom
} from "../atoms/app.js"
import { Button, ButtonGroup } from "./ui/button.js"
import { Input } from "./ui/input.js"
import { SsoSignOutDialog } from "./sso-sign-out-dialog.js"
import { Separator } from "./ui/separator.js"

type StatusFilter = "all" | "on" | "off"

const STATUS_FILTERS: ReadonlyArray<StatusFilter> = ["all", "on", "off"]

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

interface SavePayload {
  readonly accounts: Array<{ profile: string; regions: Array<string>; enabled: boolean }>
  readonly autoDetect: boolean
  readonly autoRefresh: boolean
  readonly refreshIntervalSeconds: number
}

export function SettingsAccounts() {
  const config = useAtomValue(configQueryAtom)
  const appState = useAtomValue(appStateAtom)
  const saveConfig = useAtomSet(configSaveAtom)
  const ssoLogin = useAtomSet(notificationsSsoLoginAtom)
  const [signOutOpen, setSignOutOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const debounceRef = useRef<NodeJS.Timeout | null>(null)
  // The change waiting out the debounce. Leaving the page sends it rather than dropping it: switching an
  // account on and going straight back to the queue must still switch it on.
  const pendingRef = useRef<SavePayload | null>(null)

  useEffect(
    () => () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current)
      if (pendingRef.current !== null) saveConfig({ payload: pendingRef.current })
    },
    [saveConfig]
  )

  const saveWithDebounce = useCallback(
    (payload: SavePayload) => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current)
      pendingRef.current = payload
      debounceRef.current = setTimeout(() => {
        pendingRef.current = null
        saveConfig({ payload })
      }, 500)
    },
    [saveConfig]
  )

  const toggleAccount = useCallback(
    (profile: string, data: ConfigData) => {
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

  const setAutoDetect = useCallback(
    (autoDetect: boolean, data: ConfigData) => {
      saveWithDebounce({
        accounts: data.accounts.map((a) => ({
          profile: a.profile,
          regions: [...a.regions],
          enabled: overrides[a.profile] ?? a.enabled
        })),
        autoDetect,
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
      {AsyncResult.builder(config)
        // Only the first load replaces the list; a re-detect keeps it (and its result line) on screen.
        .onInitial(() => <p className="text-sm text-muted-foreground">Loading...</p>)
        .onFailure((cause) => {
          // Typed errors and defects alike stay here with their reason, never thrown into the router.
          const error = Cause.squash(cause)
          return (
            <p className="text-sm" role="alert">
              Couldn't read the CodeCommit settings:{" "}
              {Predicate.isError(error) ? error.message : "the server didn't answer"}. Check ~/.codecommit/config.json,
              or reload once the server is running.
            </p>
          )
        })
        .onSuccess((data) => (
          <AccountsList
            currentUser={appState.currentUser}
            data={data}
            overrides={overrides}
            search={search}
            setSearch={setSearch}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            toggleAccount={toggleAccount}
            setAutoDetect={setAutoDetect}
            onSsoLogin={(profile) => {
              try {
                ssoLogin({ payload: { profile: Schema.decodeSync(AwsProfileName)(profile) } })
              } catch {
                /* invalid profile */
              }
            }}
            onSsoLogout={() => setSignOutOpen(true)}
          />
        ))
        .render()}
      <SsoSignOutDialog onOpenChange={setSignOutOpen} open={signOutOpen} />
    </div>
  )
}

/**
 * First run: no AWS profile was detected. Names where detection looked, the two commands that create a
 * profile (this page never edits AWS files itself), and re-runs detection on request, saying what it found.
 */
function NoProfiles() {
  const paths = useAtomValue(configPathQueryAtom)
  const detectAgain = useAtomRefresh(configQueryAtom)
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const sources = AsyncResult.isSuccess(paths) ? paths.value.awsProfileSources : undefined
  return (
    <StatePanel
      action={
        <Button
          onClick={() => {
            detectAgain()
            setCheckedAt(new Date())
          }}
          size="sm"
          variant="outline"
        >
          Detect again
        </Button>
      }
      description={
        <div className="grid gap-3">
          <p>
            {sources === undefined ? (
              "CodeCommit reads profiles from your AWS CLI configuration."
            ) : (
              <>
                CodeCommit reads profiles from <code>{sources.config}</code> and <code>{sources.credentials}</code>.
              </>
            )}{" "}
            Create one with either command, then detect again:
          </p>
          <pre className="rounded-md border bg-muted px-3 py-2 text-sm">
            <code>aws configure sso{"\n"}aws configure --profile NAME</code>
          </pre>
          {checkedAt === null ? null : (
            <p role="status">Checked again at {checkedAt.toLocaleTimeString()}: still no profiles.</p>
          )}
        </div>
      }
      title="No AWS profiles found"
    />
  )
}

function AccountsList({
  currentUser,
  data,
  onSsoLogin,
  onSsoLogout,
  overrides,
  search,
  setAutoDetect,
  setSearch,
  setStatusFilter,
  statusFilter,
  toggleAccount
}: {
  readonly currentUser: string | undefined
  readonly data: ConfigData
  readonly overrides: Record<string, boolean>
  readonly search: string
  readonly setSearch: (s: string) => void
  readonly statusFilter: StatusFilter
  readonly setStatusFilter: (f: StatusFilter) => void
  readonly toggleAccount: (profile: string, data: ConfigData) => void
  readonly setAutoDetect: (autoDetect: boolean, data: ConfigData) => void
  readonly onSsoLogin: (profile: string) => void
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

  const enabledAccounts = accounts.filter((a) => a.enabled)
  const enabledCount = enabledAccounts.length
  const signedIn = currentUser !== undefined && currentUser.length > 0

  return (
    <>
      {/* A signed-in user always keeps sign-out (it ends every SSO session on the machine); "Not logged in"
          only means something once an account is switched on. */}
      <div className="flex items-center gap-2 text-sm" hidden={signedIn ? false : enabledCount === 0}>
        <UserIcon className="size-4 text-muted-foreground" />
        {signedIn ? (
          <>
            <span className="text-muted-foreground">Current user:</span>
            <span className="font-medium">{currentUser}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs"
              aria-label="Sign out of AWS SSO on this machine"
              title="Sign out of AWS SSO on this machine"
              onClick={() => onSsoLogout()}
            >
              <LogOutIcon className="size-3" />
            </Button>
          </>
        ) : (
          <>
            <span className="text-muted-foreground">Not logged in</span>
            {enabledAccounts[0] &&
              (() => {
                const profile = enabledAccounts[0].profile
                return (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-xs"
                    title="SSO Login"
                    onClick={() => onSsoLogin(profile)}
                  >
                    <LogInIcon className="size-3" />
                  </Button>
                )
              })()}
          </>
        )}
      </div>
      {accounts.length === 0 ? (
        <NoProfiles />
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
            <ButtonGroup>
              {STATUS_FILTERS.map((f) => (
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
            </ButtonGroup>
          </div>
          <div className="text-xs text-muted-foreground">
            {enabledCount} of {accounts.length} included
            {filtered.length !== accounts.length && `, ${filtered.length} shown`}
          </div>
          <div className="divide-y rounded-md border">
            {filtered.map((account) => (
              // The whole row is the switch's label, so its name is what the row shows and it is easy to hit.
              <label
                key={account.profile}
                className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3 py-2"
              >
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-medium break-words">{account.profile}</span>
                  <span className="text-xs text-muted-foreground">
                    {account.regions.join(", ") || "default region"}
                  </span>
                </span>
                <input
                  checked={account.enabled}
                  className={switchStyles.switch}
                  onChange={() => toggleAccount(account.profile, data)}
                  role="switch"
                  type="checkbox"
                />
              </label>
            ))}
            {filtered.length === 0 && (
              <p className="px-3 py-4 text-center text-sm text-muted-foreground">No matching accounts</p>
            )}
          </div>
        </>
      )}
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
        <input
          checked={data.autoDetect}
          className="size-5 shrink-0 cursor-pointer"
          onChange={() => setAutoDetect(!data.autoDetect, data)}
          type="checkbox"
        />
        Add new profiles from your AWS configuration automatically
      </label>
    </>
  )
}
