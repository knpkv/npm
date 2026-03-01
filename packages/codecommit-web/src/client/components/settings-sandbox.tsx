import { Result, useAtomSet, useAtomValue } from "@effect-atom/atom-react"
import { BoxIcon, CheckIcon, PlusIcon, TrashIcon, XIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { configQueryAtom, configSaveAtom } from "../atoms/app.js"
import { Button } from "./ui/button.js"
import { Input } from "./ui/input.js"
import { Separator } from "./ui/separator.js"

interface VolumeMount {
  readonly hostPath: string
  readonly containerPath: string
  readonly readonly: boolean
}

interface SandboxSettings {
  readonly image: string
  readonly extensions: ReadonlyArray<string>
  readonly setupCommands: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly enableClaudeCode: boolean
  readonly volumeMounts: ReadonlyArray<VolumeMount>
  readonly cloneDepth: number
}

const DEFAULTS: SandboxSettings = {
  image: "codercom/code-server:latest",
  extensions: [],
  setupCommands: [],
  env: {},
  enableClaudeCode: true,
  volumeMounts: [],
  cloneDepth: 0
}

export function SettingsSandbox() {
  const config = useAtomValue(configQueryAtom)
  const saveConfig = useAtomSet(configSaveAtom)
  type ConfigValue = Extract<typeof config, { readonly _tag: "Success" }>["value"]
  const configRef = useRef<ConfigValue | null>(null)
  const [local, setLocal] = useState<SandboxSettings | null>(null)
  const [saved, setSaved] = useState<SandboxSettings | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (Result.isSuccess(config)) {
      configRef.current = config.value
      if (!local) {
        const initial = config.value.sandbox ?? DEFAULTS
        setLocal(initial)
        setSaved(initial)
      }
    }
  }, [config, local])

  const dirty = useMemo(
    () => local !== null && saved !== null && JSON.stringify(local) !== JSON.stringify(saved),
    [local, saved]
  )

  const update = useCallback((patch: Partial<SandboxSettings>) => {
    setLocal((prev) => (prev ? { ...prev, ...patch } : prev))
  }, [])

  const handleSave = useCallback(() => {
    const data = configRef.current
    if (!data || !local) return
    setSaving(true)
    saveConfig({
      payload: {
        accounts: data.accounts.map((a) => ({
          profile: a.profile,
          regions: [...a.regions],
          enabled: a.enabled
        })),
        autoDetect: data.autoDetect,
        autoRefresh: data.autoRefresh,
        refreshIntervalSeconds: data.refreshIntervalSeconds,
        sandbox: local
      }
    })
    setSaved(local)
    setTimeout(() => setSaving(false), 600)
  }, [saveConfig, local])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Sandbox</h2>
          <p className="text-sm text-muted-foreground">Docker sandbox defaults for code review environments</p>
        </div>
        {local && (
          <Button size="sm" className="h-8 gap-1.5 px-3" disabled={!dirty && !saving} onClick={handleSave}>
            {saving ? (
              <>
                <CheckIcon className="size-3.5" /> Saved
              </>
            ) : (
              "Save"
            )}
          </Button>
        )}
      </div>
      <Separator />
      {Result.builder(config)
        .onInitialOrWaiting(() => <p className="text-sm text-muted-foreground">Loading...</p>)
        .onError(() => <p className="text-sm text-destructive">Failed to load config</p>)
        .onDefect(() => <p className="text-sm text-destructive">Failed to load config</p>)
        .onSuccess(() => local && <SandboxForm settings={local} onChange={update} />)
        .render()}
    </div>
  )
}

function SandboxForm({
  settings,
  onChange
}: {
  readonly settings: SandboxSettings
  readonly onChange: (patch: Partial<SandboxSettings>) => void
}) {
  const [newExt, setNewExt] = useState("")
  const [newCmd, setNewCmd] = useState("")
  const [newEnvKey, setNewEnvKey] = useState("")
  const [newEnvVal, setNewEnvVal] = useState("")
  const [newMountHost, setNewMountHost] = useState("")
  const [newMountContainer, setNewMountContainer] = useState("")
  const [newMountRo, setNewMountRo] = useState(false)

  return (
    <div className="space-y-6">
      {/* Image */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Docker Image</label>
        <Input
          value={settings.image}
          placeholder="codercom/code-server:latest"
          onChange={(e) => onChange({ image: e.target.value })}
          className="h-8 text-sm"
        />
        <p className="text-xs text-muted-foreground">
          Base image for sandboxes. Must have code-server or install via setup commands.
        </p>
      </div>

      {/* Clone Depth */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Clone Depth</label>
        <div className="flex gap-1.5">
          {[
            { label: "Full", value: 0 },
            { label: "1", value: 1 },
            { label: "10", value: 10 },
            { label: "50", value: 50 },
            { label: "100", value: 100 }
          ].map((opt) => (
            <Button
              key={opt.value}
              variant={settings.cloneDepth === opt.value ? "default" : "outline"}
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={() => onChange({ cloneDepth: opt.value })}
            >
              {opt.label}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          0 = full history. Higher values speed up clone but limit git log.
        </p>
      </div>

      <Separator />

      {/* Extensions */}
      <div className="space-y-2">
        <label className="text-sm font-medium">VS Code Extensions</label>
        <p className="text-xs text-muted-foreground">Installed via code-server --install-extension</p>
        <ExtensionPresets settings={settings} onChange={onChange} />
        <div className="flex flex-wrap gap-1.5">
          {settings.extensions.map((ext) => (
            <span key={ext} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs">
              <BoxIcon className="size-3 text-muted-foreground" />
              {ext}
              <button
                className="ml-0.5 text-muted-foreground hover:text-foreground"
                onClick={() => onChange({ extensions: settings.extensions.filter((e) => e !== ext) })}
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-1.5">
          <Input
            value={newExt}
            placeholder="publisher.extension-id"
            onChange={(e) => setNewExt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newExt.trim()) {
                onChange({ extensions: [...settings.extensions, newExt.trim()] })
                setNewExt("")
              }
            }}
            className="h-8 text-sm flex-1"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            disabled={!newExt.trim()}
            onClick={() => {
              onChange({ extensions: [...settings.extensions, newExt.trim()] })
              setNewExt("")
            }}
          >
            <PlusIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      <Separator />

      {/* Setup Commands */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Setup Commands</label>
        <p className="text-xs text-muted-foreground">Shell commands run in container after ready</p>
        <CommandPresets settings={settings} onChange={onChange} />
        <div className="space-y-1.5">
          {settings.setupCommands.map((cmd, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <code className="flex-1 rounded-md bg-muted px-2 py-1 text-xs font-mono truncate">{cmd}</code>
              <button
                className="text-muted-foreground hover:text-destructive shrink-0"
                onClick={() => onChange({ setupCommands: settings.setupCommands.filter((_, j) => j !== i) })}
              >
                <TrashIcon className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
        <div className="flex gap-1.5">
          <Input
            value={newCmd}
            placeholder="npm i -g tsx"
            onChange={(e) => setNewCmd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newCmd.trim()) {
                onChange({ setupCommands: [...settings.setupCommands, newCmd.trim()] })
                setNewCmd("")
              }
            }}
            className="h-8 text-sm font-mono flex-1"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            disabled={!newCmd.trim()}
            onClick={() => {
              onChange({ setupCommands: [...settings.setupCommands, newCmd.trim()] })
              setNewCmd("")
            }}
          >
            <PlusIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      <Separator />

      {/* Environment Variables */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Environment Variables</label>
        <p className="text-xs text-muted-foreground">Extra env vars injected into sandbox container</p>
        <div className="space-y-1.5">
          {Object.entries(settings.env).map(([key, val]) => (
            <div key={key} className="flex items-center gap-1.5">
              <code className="rounded-md bg-muted px-2 py-1 text-xs font-mono">{key}</code>
              <span className="text-xs text-muted-foreground">=</span>
              <code className="flex-1 rounded-md bg-muted px-2 py-1 text-xs font-mono truncate">{val}</code>
              <button
                className="text-muted-foreground hover:text-destructive shrink-0"
                onClick={() => {
                  const next = { ...settings.env }
                  delete next[key]
                  onChange({ env: next })
                }}
              >
                <TrashIcon className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
        <div className="flex gap-1.5">
          <Input
            value={newEnvKey}
            placeholder="KEY"
            onChange={(e) => setNewEnvKey(e.target.value)}
            className="h-8 text-sm font-mono w-32"
          />
          <span className="flex items-center text-xs text-muted-foreground">=</span>
          <Input
            value={newEnvVal}
            placeholder="value"
            onChange={(e) => setNewEnvVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newEnvKey.trim()) {
                onChange({ env: { ...settings.env, [newEnvKey.trim()]: newEnvVal } })
                setNewEnvKey("")
                setNewEnvVal("")
              }
            }}
            className="h-8 text-sm font-mono flex-1"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            disabled={!newEnvKey.trim()}
            onClick={() => {
              onChange({ env: { ...settings.env, [newEnvKey.trim()]: newEnvVal } })
              setNewEnvKey("")
              setNewEnvVal("")
            }}
          >
            <PlusIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      <Separator />

      {/* Volume Mounts */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Volume Mounts</label>
        <p className="text-xs text-muted-foreground">Map host paths into the container</p>
        <MountPresets settings={settings} onChange={onChange} />
        <div className="space-y-1.5">
          {settings.volumeMounts.map((mount, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <code className="rounded-md bg-muted px-2 py-1 text-xs font-mono truncate">{mount.hostPath}</code>
              <span className="text-xs text-muted-foreground shrink-0">:</span>
              <code className="flex-1 rounded-md bg-muted px-2 py-1 text-xs font-mono truncate">
                {mount.containerPath}
              </code>
              {mount.readonly && <span className="text-xs text-muted-foreground shrink-0">(ro)</span>}
              <button
                className="text-muted-foreground hover:text-destructive shrink-0"
                onClick={() => onChange({ volumeMounts: settings.volumeMounts.filter((_, j) => j !== i) })}
              >
                <TrashIcon className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
        <div className="flex gap-1.5 items-center">
          <Input
            value={newMountHost}
            placeholder="/host/path"
            onChange={(e) => setNewMountHost(e.target.value)}
            className="h-8 text-sm font-mono flex-1"
          />
          <span className="text-xs text-muted-foreground shrink-0">:</span>
          <Input
            value={newMountContainer}
            placeholder="/container/path"
            onChange={(e) => setNewMountContainer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newMountHost.trim() && newMountContainer.trim()) {
                onChange({
                  volumeMounts: [
                    ...settings.volumeMounts,
                    { hostPath: newMountHost.trim(), containerPath: newMountContainer.trim(), readonly: newMountRo }
                  ]
                })
                setNewMountHost("")
                setNewMountContainer("")
                setNewMountRo(false)
              }
            }}
            className="h-8 text-sm font-mono flex-1"
          />
          <Button
            variant={newMountRo ? "default" : "outline"}
            size="sm"
            className="h-8 px-2 text-xs shrink-0"
            onClick={() => setNewMountRo(!newMountRo)}
            title="Read-only"
          >
            RO
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            disabled={!newMountHost.trim() || !newMountContainer.trim()}
            onClick={() => {
              onChange({
                volumeMounts: [
                  ...settings.volumeMounts,
                  { hostPath: newMountHost.trim(), containerPath: newMountContainer.trim(), readonly: newMountRo }
                ]
              })
              setNewMountHost("")
              setNewMountContainer("")
              setNewMountRo(false)
            }}
          >
            <PlusIcon className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}

const EXTENSION_PRESETS: ReadonlyArray<{ label: string; id: string }> = [
  { label: "Claude Code", id: "anthropic.claude-code" },
  { label: "ESLint", id: "dbaeumer.vscode-eslint" },
  { label: "Prettier", id: "esbenp.prettier-vscode" },
  { label: "GitLens", id: "eamodio.gitlens" },
  { label: "Error Lens", id: "usernamehw.errorlens" }
]

function ExtensionPresets({
  settings,
  onChange
}: {
  readonly settings: SandboxSettings
  readonly onChange: (patch: Partial<SandboxSettings>) => void
}) {
  const available = useMemo(
    () => EXTENSION_PRESETS.filter((p) => !settings.extensions.includes(p.id)),
    [settings.extensions]
  )

  if (available.length === 0) return null

  return (
    <div className="flex flex-wrap gap-1.5">
      {available.map((preset) => (
        <Button
          key={preset.id}
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => onChange({ extensions: [...settings.extensions, preset.id] })}
        >
          <PlusIcon className="size-3" />
          {preset.label}
        </Button>
      ))}
    </div>
  )
}

const COMMAND_PRESETS: ReadonlyArray<{ label: string; cmd: string }> = [
  {
    label: "Node 22",
    cmd: "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
  },
  { label: "Claude Code", cmd: "sudo npm i -g @anthropic-ai/claude-code" },
  { label: "pnpm", cmd: "sudo npm i -g pnpm" },
  {
    label: "Bun",
    cmd: "curl -fsSL https://bun.sh/install | bash && echo 'export PATH=\"$HOME/.bun/bin:$PATH\"' >> ~/.bashrc && echo 'export PATH=\"$HOME/.bun/bin:$PATH\"' >> ~/.profile"
  }
]

const MOUNT_PRESETS: ReadonlyArray<{ label: string; mount: VolumeMount }> = [
  {
    label: "VS Code Extensions",
    mount: {
      hostPath: "~/.vscode/extensions",
      containerPath: "/home/coder/.local/share/code-server/extensions",
      readonly: false
    }
  },
  {
    label: "VS Code Settings",
    mount: {
      hostPath: "~/Library/Application Support/Code/User/settings.json",
      containerPath: "/home/coder/.local/share/code-server/User/settings.json",
      readonly: true
    }
  },
  {
    label: "VS Code Keybindings",
    mount: {
      hostPath: "~/Library/Application Support/Code/User/keybindings.json",
      containerPath: "/home/coder/.local/share/code-server/User/keybindings.json",
      readonly: true
    }
  },
  {
    label: "SSH Keys",
    mount: { hostPath: "~/.ssh", containerPath: "/home/coder/.ssh", readonly: true }
  },
  {
    label: "Git Config",
    mount: { hostPath: "~/.gitconfig", containerPath: "/home/coder/.gitconfig", readonly: true }
  },
  {
    label: "AWS Credentials",
    mount: { hostPath: "~/.aws", containerPath: "/home/coder/.aws", readonly: true }
  },
  {
    label: "Claude Config",
    mount: { hostPath: "~/.claude", containerPath: "/home/coder/.claude", readonly: false }
  }
]

function CommandPresets({
  settings,
  onChange
}: {
  readonly settings: SandboxSettings
  readonly onChange: (patch: Partial<SandboxSettings>) => void
}) {
  const available = useMemo(
    () => COMMAND_PRESETS.filter((p) => !settings.setupCommands.some((c) => c === p.cmd)),
    [settings.setupCommands]
  )

  if (available.length === 0) return null

  return (
    <div className="flex flex-wrap gap-1.5">
      {available.map((preset) => (
        <Button
          key={preset.label}
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => onChange({ setupCommands: [...settings.setupCommands, preset.cmd] })}
        >
          <PlusIcon className="size-3" />
          {preset.label}
        </Button>
      ))}
    </div>
  )
}

function MountPresets({
  settings,
  onChange
}: {
  readonly settings: SandboxSettings
  readonly onChange: (patch: Partial<SandboxSettings>) => void
}) {
  const available = useMemo(
    () => MOUNT_PRESETS.filter((p) => !settings.volumeMounts.some((m) => m.hostPath === p.mount.hostPath)),
    [settings.volumeMounts]
  )

  if (available.length === 0) return null

  return (
    <div className="flex flex-wrap gap-1.5">
      {available.map((preset) => (
        <Button
          key={preset.label}
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => onChange({ volumeMounts: [...settings.volumeMounts, preset.mount] })}
        >
          <PlusIcon className="size-3" />
          {preset.label}
        </Button>
      ))}
    </div>
  )
}
