import { RegistryContext, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { AwsProfileName } from "@knpkv/codecommit-core/Domain.js"
import { Schema } from "effect"
import * as Cause from "effect/Cause"
import * as Predicate from "effect/Predicate"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { LogInIcon, LogOutIcon, SearchIcon, UserIcon } from "lucide-react"
import { StatePanel } from "@knpkv/rly/primitives"
import switchStyles from "./settings-accounts.module.css"
import { type ContextType, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
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

type Registry = ContextType<typeof RegistryContext>

/**
 * Sends a config save that outlives this page: the mutation stays mounted until it settles, so leaving
 * Settings right after a change can't dispose the request mid-flight. `onSettled` gets whether it saved.
 */
const saveDetached = (registry: Registry, payload: SavePayload, onSettled?: (saved: boolean) => void): void => {
  const release = registry.mount(configSaveAtom)
  const unsubscribe = registry.subscribe(configSaveAtom, (result) => {
    if (result.waiting || AsyncResult.isInitial(result)) return
    unsubscribe()
    release()
    onSettled?.(AsyncResult.isSuccess(result))
  })
  registry.set(configSaveAtom, { payload })
}

export function SettingsAccounts() {
  const config = useAtomValue(configQueryAtom)
  const appState = useAtomValue(appStateAtom)
  const registry = useContext(RegistryContext)
  const ssoLogin = useAtomSet(notificationsSsoLoginAtom)
  const [signOutOpen, setSignOutOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  // The auto-detect choice made on this page; the config query isn't refetched after a save.
  const [autoDetectChoice, setAutoDetectChoice] = useState<boolean | null>(null)
  const debounceRef = useRef<NodeJS.Timeout | null>(null)
  // The change waiting out the debounce. Leaving the page sends it rather than dropping it: switching an
  // account on and going straight back to the queue must still switch it on.
  const pendingRef = useRef<SavePayload | null>(null)

  useEffect(
    () => () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current)
      if (pendingRef.current !== null) saveDetached(registry, pendingRef.current)
    },
    [registry]
  )

  const saveWithDebounce = useCallback(
    (payload: SavePayload) => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current)
      pendingRef.current = payload
      debounceRef.current = setTimeout(() => {
        pendingRef.current = null
        saveDetached(registry, payload)
      }, 500)
    },
    [registry]
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
        autoDetect: autoDetectChoice ?? data.autoDetect,
        autoRefresh: data.autoRefresh,
        refreshIntervalSeconds: data.refreshIntervalSeconds
      })
    },
    [saveWithDebounce, overrides, autoDetectChoice]
  )

  const setAutoDetect = useCallback(
    (autoDetect: boolean, data: ConfigData) => {
      setAutoDetectChoice(autoDetect)
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
            autoDetect={autoDetectChoice ?? data.autoDetect}
            data={data}
            overrides={overrides}
            search={search}
            setSearch={setSearch}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            toggleAccount={toggleAccount}
            setAutoDetect={setAutoDetect}
            turnOnAutoDetect={(data) => {
              // An explicit "detect" with auto-detect off: save the switch now, then read the config again.
              setAutoDetectChoice(true)
              return new Promise<boolean>((resolve) =>
                saveDetached(
                  registry,
                  {
                    accounts: data.accounts.map((a) => ({
                      profile: a.profile,
                      regions: [...a.regions],
                      enabled: overrides[a.profile] ?? a.enabled
                    })),
                    autoDetect: true,
                    autoRefresh: data.autoRefresh,
                    refreshIntervalSeconds: data.refreshIntervalSeconds
                  },
                  resolve
                )
              )
            }}
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
 * Where a Detect again request is: sent (holding the result it started from, since a fast re-read can
 * finish without ever showing as running), seen running, finished with no profiles, or failed.
 */
type DetectPhase<A> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Requested"; readonly from: A }
  | { readonly _tag: "Running" }
  | { readonly _tag: "NoneFound"; readonly at: Date }
  | { readonly _tag: "Failed"; readonly reason: string }

/**
 * First run: no AWS profile was detected. Names where detection looked, the two commands that create a
 * profile (this page never edits AWS files itself), and re-runs detection on request. The result line
 * appears only once the re-read has finished; a profile it finds replaces this panel with the list.
 * With auto-detect off, a plain re-read finds nothing, so the action turns auto-detect on first.
 */
function NoProfiles({
  autoDetect,
  turnOnAutoDetect
}: {
  readonly autoDetect: boolean
  readonly turnOnAutoDetect: () => Promise<boolean>
}) {
  const paths = useAtomValue(configPathQueryAtom)
  const config = useAtomValue(configQueryAtom)
  const detectAgain = useAtomRefresh(configQueryAtom)
  const [phase, setPhase] = useState<DetectPhase<typeof config>>({ _tag: "Idle" })
  const sources = AsyncResult.isSuccess(paths) ? paths.value.awsProfileSources : undefined

  useEffect(() => {
    if (phase._tag === "Requested" && config.waiting) setPhase({ _tag: "Running" })
    const finished = phase._tag === "Running" || (phase._tag === "Requested" && config !== phase.from)
    if (finished && !config.waiting) {
      setPhase(
        AsyncResult.isSuccess(config)
          ? { _tag: "NoneFound", at: new Date() }
          : { _tag: "Failed", reason: "the settings couldn't be read" }
      )
    }
  }, [config, phase])

  const detect = () => {
    setPhase({ _tag: "Requested", from: config })
    if (autoDetect) {
      detectAgain()
      return
    }
    void turnOnAutoDetect().then((saved) => {
      if (saved) detectAgain()
      else setPhase({ _tag: "Failed", reason: "auto-detect couldn't be switched on" })
    })
  }

  const busy = phase._tag === "Requested" || phase._tag === "Running"
  return (
    <StatePanel
      action={
        <Button disabled={busy} onClick={detect} size="sm" variant="outline">
          {busy ? "Detecting…" : autoDetect ? "Detect again" : "Turn on auto-detect and detect"}
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
          {phase._tag === "NoneFound" ? (
            <p role="status">Checked again at {phase.at.toLocaleTimeString()}: still no profiles.</p>
          ) : phase._tag === "Failed" ? (
            <p role="alert">Couldn't detect profiles: {phase.reason}.</p>
          ) : null}
        </div>
      }
      title="No AWS profiles found"
    />
  )
}

function AccountsList({
  autoDetect,
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
  toggleAccount,
  turnOnAutoDetect
}: {
  readonly autoDetect: boolean
  readonly currentUser: string | undefined
  readonly data: ConfigData
  readonly overrides: Record<string, boolean>
  readonly search: string
  readonly setSearch: (s: string) => void
  readonly statusFilter: StatusFilter
  readonly setStatusFilter: (f: StatusFilter) => void
  readonly toggleAccount: (profile: string, data: ConfigData) => void
  readonly setAutoDetect: (autoDetect: boolean, data: ConfigData) => void
  readonly turnOnAutoDetect: (data: ConfigData) => Promise<boolean>
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
        <NoProfiles autoDetect={autoDetect} turnOnAutoDetect={() => turnOnAutoDetect(data)} />
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
          checked={autoDetect}
          className="size-5 shrink-0 cursor-pointer"
          onChange={() => setAutoDetect(!autoDetect, data)}
          type="checkbox"
        />
        Add new profiles from your AWS configuration automatically
      </label>
    </>
  )
}
